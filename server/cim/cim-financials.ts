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
  type UiWorkingCapitalItem,
} from "../financial/shape";
import { isExcludedWorkingCapitalAsset, isExcludedWorkingCapitalLiability, workingCapitalHistory } from "../financial/normalization-rules";

type AnalysisLike = Pick<FinancialAnalysis, "id" | "version" | "status" | "brokerReviewedAt"> & {
  reclassifiedPnl?: unknown;
  normalization?: unknown;
  workingCapital?: unknown;
  reclassifiedBalanceSheet?: unknown;
  createdAt?: Date | string | null;
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
  /**
   * Set when the broker's own earnings figure overrules (part of) the bridge
   * (earnings-canon.ts withBridgeOverride): what the writer is told instead.
   */
  bridgeWithheld?: string | null;
  /** Always on the cash-free, debt-free basis the peg uses (cimWorkingCapital). */
  workingCapital: CimWorkingCapital | null;
  /** Year-end debt from the balance sheet (cimDebt), so a debt figure is always tied to its year. */
  debt?: CimDebt | null;
  /**
   * When each of the bridge's figures last changed, per metric and year
   * ("adjusted|2024" / "sde|2023" → ISO; see bridgeFigures): a broker's
   * add-back edit that moved that figure, else the run that produced it. A
   * broker earnings figure set before its own figure's date no longer
   * overrules the bridge (earnings-canon.ts). Absent when unknown.
   */
  bridgeChangedAt?: Record<string, string> | null;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * Working capital as a CIM may state it: cash-free and debt-free — the
 * basis a peg is always set on.
 *
 * Pacific (2026-09-26): an analysis stored before the cash-free rule listed
 * cash and the current portion of long-term debt as working-capital lines
 * ($1,022,999 "net working capital"), the writer set that beside the $2.4M
 * peg and told buyers of a seller-funded "shortfall" that doesn't exist (on
 * the peg's own basis NWC was above $2.4M). The analysis's exclusions
 * (normalization-rules.ts) are applied here to whatever is stored, so an
 * old run and a new one read the same; the peg is the analysis's.
 */
export interface CimWorkingCapital {
  asOfPeriod?: string;
  currentAssets: UiWorkingCapitalItem[];
  currentLiabilities: UiWorkingCapitalItem[];
  /** Cash-free, debt-free: the lines above. */
  netWorkingCapital: number;
  /** Lines left out (cash, bank debt, current portion of debt, shareholder loans, income taxes). */
  excluded: Array<UiWorkingCapitalItem & { side: "asset" | "liability" }>;
  /** Total current assets − total current liabilities, cash and debt included: never NWC in a CIM. */
  allInNetWorkingCapital: number | null;
  /** Year-end NWC per fiscal year on the same basis (from the balance sheet). */
  history?: Record<string, number>;
  /**
   * The same figures with income taxes payable counted as working capital.
   * The analysis leaves them out (settled at closing); some purchase
   * agreements keep them in, so a CIM stating that figure isn't wrong
   * (Pacific's statements: $2,420,000 with them, $2,538,000 without).
   */
  withIncomeTaxes?: { incomeTaxesPayable: number; netWorkingCapital: number; history?: Record<string, number> };
  pegAmount: number | null;
  pegBasis?: string;
  /**
   * A stored peg that is net working capital counting cash and debt (an
   * analysis from before the cash-free rule — Ridgeline's $1,555,000 peg was
   * its all-in $1,555,130): never compared with the cash-free figure, so it
   * isn't stated at all. `pegAmount` is null when this is set.
   */
  pegWithheld?: { amount: number; allIn: number; reason: string };
}

const itemSum = (xs: UiWorkingCapitalItem[]) => xs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
const INCOME_TAX_PAYABLE = /\b(?:income|corporate)\s+(?:income\s+)?tax(?:es)?\s+payable\b/i;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1000, Math.abs(b) * 0.005);

/** Total current assets − total current liabilities per year, cash and debt included (never NWC — only to recognise a figure on that basis). */
function allInHistory(bs: UiReclassifiedTable | null | undefined): Record<string, number> {
  if (!bs || !Array.isArray(bs.rows)) return {};
  const years = bs.years?.length ? bs.years : Array.from(new Set(bs.rows.flatMap((r) => Object.keys(r.values ?? {}))));
  const out: Record<string, number> = {};
  for (const y of years) {
    const total = (category: string) => bs.rows.filter((r) => r.category === category && Number.isFinite(r.values?.[y])).map((r) => r.values[y]);
    const ca = total("Current Assets");
    const cl = total("Current Liabilities");
    if (ca.length === 0 || cl.length === 0) continue;
    out[y] = Math.round(Math.abs(sum(ca)) - Math.abs(sum(cl)));
  }
  return out;
}

export function cimWorkingCapital(wc: UiWorkingCapital | null | undefined, balanceSheet?: UiReclassifiedTable | null): CimWorkingCapital | null {
  if (!wc || (!Array.isArray(wc.currentAssets) && !Array.isArray(wc.currentLiabilities))) return null;
  const assets = (wc.currentAssets ?? []).filter((i) => i && i.name);
  const liabilities = (wc.currentLiabilities ?? []).filter((i) => i && i.name);
  const excluded: CimWorkingCapital["excluded"] = [
    ...assets.filter((i) => isExcludedWorkingCapitalAsset(i.name)).map((i) => ({ ...i, side: "asset" as const })),
    ...liabilities.filter((i) => isExcludedWorkingCapitalLiability(i.name)).map((i) => ({ ...i, side: "liability" as const })),
  ];
  const currentAssets = assets.filter((i) => !isExcludedWorkingCapitalAsset(i.name));
  const currentLiabilities = liabilities.filter((i) => !isExcludedWorkingCapitalLiability(i.name));
  const hasLines = currentAssets.length + currentLiabilities.length > 0;
  const allIn = assets.length + liabilities.length > 0 ? itemSum(assets) - itemSum(liabilities) : null;
  // No lines at all: only the stored total, which can't be checked for cash — trust it only when nothing was listed.
  const netWorkingCapital = hasLines || excluded.length > 0 ? itemSum(currentAssets) - itemSum(currentLiabilities) : wc.netWorkingCapital;
  const fromSheet = workingCapitalHistory(balanceSheet);
  const history = Object.keys(fromSheet).length > 0 ? fromSheet : wc.history;
  let peg = typeof wc.pegAmount === "number" ? wc.pegAmount : typeof wc.targetNwc === "number" ? wc.targetNwc : null;

  // Income taxes payable counted in, for a CIM that states that figure.
  const taxLines = excluded.filter((i) => i.side === "liability" && INCOME_TAX_PAYABLE.test(i.name));
  let withIncomeTaxes: CimWorkingCapital["withIncomeTaxes"];
  if (taxLines.length > 0 && itemSum(taxLines) !== 0) {
    const taxes = itemSum(taxLines);
    const byYear: Record<string, number> = {};
    if (Object.keys(fromSheet).length > 0 && balanceSheet) {
      for (const [y, v] of Object.entries(fromSheet)) {
        const t = balanceSheet.rows.filter((r) => r.category === "Current Liabilities" && INCOME_TAX_PAYABLE.test(r.name) && Number.isFinite(r.values?.[y])).map((r) => Math.abs(r.values[y]));
        if (t.length > 0) byYear[y] = v - sum(t);
      }
    }
    withIncomeTaxes = { incomeTaxesPayable: taxes, netWorkingCapital: netWorkingCapital - taxes, ...(Object.keys(byYear).length > 0 ? { history: byYear } : {}) };
  }

  // A peg on the all-in basis (cash and debt counted) is withheld: set beside
  // the cash-free figure it would invent a shortfall or an excess.
  let pegWithheld: CimWorkingCapital["pegWithheld"];
  if (peg !== null) {
    const allInYears = allInHistory(balanceSheet);
    const allInValues = [...(excluded.length > 0 && allIn !== null ? [allIn] : []), ...Object.values(allInYears)];
    const avg = (xs: number[]) => (xs.length > 1 ? [xs.reduce((s, x) => s + x, 0) / xs.length] : []);
    const cashFree = [
      netWorkingCapital,
      ...Object.values(history ?? {}),
      ...avg(Object.values(history ?? {})),
      ...(withIncomeTaxes ? [withIncomeTaxes.netWorkingCapital, ...Object.values(withIncomeTaxes.history ?? {}), ...avg(Object.values(withIncomeTaxes.history ?? {}))] : []),
    ];
    const hit = [...allInValues, ...avg(Object.values(allInYears))].find((v) => near(peg!, v));
    if (hit !== undefined && !cashFree.some((v) => near(peg!, v)) && !near(hit, netWorkingCapital)) {
      pegWithheld = {
        amount: peg,
        allIn: Math.round(hit),
        reason: `the peg on file (${money(peg)}) is net working capital counting cash and debt (${money(Math.round(hit))}), not the cash-free, debt-free basis a peg is set on`,
      };
      peg = null;
    }
  }
  return {
    ...(wc.asOfPeriod ? { asOfPeriod: wc.asOfPeriod } : {}),
    currentAssets,
    currentLiabilities,
    netWorkingCapital,
    excluded,
    allInNetWorkingCapital: excluded.length > 0 ? allIn : null,
    ...(history && Object.keys(history).length > 0 ? { history } : {}),
    ...(withIncomeTaxes ? { withIncomeTaxes } : {}),
    pegAmount: peg,
    ...(wc.pegBasis && peg !== null ? { pegBasis: wc.pegBasis } : {}),
    ...(pegWithheld ? { pegWithheld } : {}),
  };
}

/** Year-end debt per fiscal year, from the balance sheet. */
export interface CimDebt {
  years: string[];
  /** Term debt (loans, equipment loans, notes, finance leases), current portion included. */
  termDebt: Record<string, number>;
  currentPortion: Record<string, number>;
  /** Drawn on the operating line / bank overdraft. */
  bankIndebtedness: Record<string, number>;
}

const BANK_LINE = /\b(bank\s+indebtedness|overdraft|operating\s+(?:line|loan)|lines?\s+of\s+credit|revolv\w*|credit\s+facilit(?:y|ies))\b/i;
const TERM_DEBT = /\b(long[- ]term\s+debt|term\s+loans?|equipment\s+loans?|vehicle\s+loans?|notes?\s+payable|(?:capital|finance)\s+lease\s+obligations?|bank\s+loans?|mortgages?(?:\s+payable)?|current\s+portion)\b/i;

export function cimDebt(balanceSheet: UiReclassifiedTable | null | undefined): CimDebt | null {
  if (!balanceSheet || !Array.isArray(balanceSheet.rows)) return null;
  const rows = balanceSheet.rows.filter((r) => /liabilit/i.test(r.category ?? "") && !/deferred|future\s+income\s+tax|shareholder|due\s+to/i.test(r.name));
  const years = (balanceSheet.years?.length ? balanceSheet.years : Array.from(new Set(rows.flatMap((r) => Object.keys(r.values ?? {}))))).slice().sort();
  const termDebt: Record<string, number> = {};
  const currentPortion: Record<string, number> = {};
  const bankIndebtedness: Record<string, number> = {};
  for (const y of years) {
    const v = (r: (typeof rows)[number]) => (Number.isFinite(r.values?.[y]) ? Math.abs(r.values[y]) : null);
    const bank = rows.filter((r) => BANK_LINE.test(r.name)).map(v).filter((x): x is number => x !== null);
    const term = rows.filter((r) => !BANK_LINE.test(r.name) && TERM_DEBT.test(r.name)).map(v).filter((x): x is number => x !== null);
    const current = rows.filter((r) => /current\s+portion/i.test(r.name)).map(v).filter((x): x is number => x !== null);
    if (bank.length) bankIndebtedness[y] = sum(bank);
    if (term.length) termDebt[y] = sum(term);
    if (current.length) currentPortion[y] = sum(current);
  }
  const used = years.filter((y) => y in termDebt || y in bankIndebtedness);
  if (used.length === 0) return null;
  return { years: used, termDebt, currentPortion, bankIndebtedness };
}

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

// ── When the bridge last changed ─────────────────────────────────────────

/**
 * The normalization's stamps of its last earnings changes, one per metric
 * and year ({ "adjusted|2024": iso, "sde|2023": iso } — see
 * stampEarningsChange). Per figure, not per analysis: approving a 2023
 * add-back, or the SDE-only owner salary, leaves the broker's 2024 adjusted
 * EBITDA decision standing.
 */
const EARNINGS_STAMP = "earningsChangedAt";

function isoOf(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A bridge's earnings figures per metric and year, as the earnings canon
 * reads them: "adjusted" = adjusted EBITDA (the headline in EBITDA mode,
 * the subtotal in SDE mode), "sde" = SDE. Keyed "adjusted|2024". Pure.
 */
export function bridgeFigures(b: CimFinancials["bridge"] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!b) return out;
  const series: Array<["adjusted" | "sde", Record<string, number> | null | undefined]> = [
    ["adjusted", b.metric === "ebitda" ? b.adjusted : b.adjustedEbitda],
    ["sde", b.metric === "sde" ? b.adjusted : b.sde],
  ];
  for (const [metric, m] of series) {
    for (const [y, v] of Object.entries(m ?? {})) if (typeof v === "number" && Number.isFinite(v)) out[`${metric}|${y}`] = v;
  }
  return out;
}

/** The normalization's earnings figures, rounded to the dollar (null = no bridge). */
function earningsOf(normalization: unknown): Record<string, number> | null {
  if (!normalization || typeof normalization !== "object") return null;
  const row = normalizeFinancialAnalysisRow({ normalization } as Record<string, unknown>) as Record<string, any>;
  const norm = row.normalization as UiNormalization | null;
  if (!norm || !Array.isArray(norm.addbacks)) return null;
  const figures = bridgeFigures(bridgeOf(norm));
  return Object.fromEntries(Object.entries(figures).map(([k, v]) => [k, Math.round(v)]));
}

/** The stored stamps, per figure. (A single date stamps every figure.) */
function stampsOf(normalization: unknown, keys: string[]): Record<string, string> {
  const raw = normalization && typeof normalization === "object" ? (normalization as Record<string, unknown>)[EARNINGS_STAMP] : undefined;
  const out: Record<string, string> = {};
  if (typeof raw === "string") {
    const iso = isoOf(raw);
    if (iso) for (const k of keys) out[k] = iso;
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const iso = isoOf(v);
      if (iso) out[k] = iso;
    }
  }
  return out;
}

/**
 * A broker edit of the normalization (PATCH): stamps each adjusted EBITDA /
 * SDE figure (per year) that the edit moved, and carries the earlier stamp
 * of every figure it didn't (a note, a reclassification that moves no
 * total, an add-back in another year or for the other metric). Pure.
 */
export function stampEarningsChange<T>(prior: unknown, next: T, now: Date): T {
  if (!next || typeof next !== "object") return next;
  const before = earningsOf(prior) ?? {};
  const after = earningsOf(next) ?? {};
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  const priorStamps = stampsOf(prior, keys);
  const stamps: Record<string, string> = {};
  for (const k of Object.keys(after).sort()) {
    if (before[k] !== after[k]) stamps[k] = now.toISOString();
    else if (priorStamps[k]) stamps[k] = priorStamps[k];
  }
  const out = { ...(next as Record<string, unknown>) };
  if (Object.keys(stamps).length > 0) out[EARNINGS_STAMP] = stamps;
  else delete out[EARNINGS_STAMP];
  return out as T;
}

/**
 * When each of the analysis's earnings figures last changed ("adjusted|2024"
 * → ISO): its own stamp (a broker edit that moved that figure), else — when
 * the run before it bridged to the same figure (a re-run carries the
 * broker's add-back decisions forward) — that run's, else the run's own
 * creation. A figure whose date is unknown is left out.
 */
export function earningsChangedAt(analysis: AnalysisLike, history: AnalysisLike[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const figures = earningsOf(analysis.normalization);
  if (!figures) return out;
  const earlier = (cur: AnalysisLike): AnalysisLike | undefined => {
    const version: number = cur.version ?? 0;
    return history
      .filter((a) => (a.version ?? 0) < version && (a.status === "completed" || a.status === "reviewed"))
      .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  };
  for (const [key, value] of Object.entries(figures)) {
    let cur: AnalysisLike | undefined = analysis;
    const seen = new Set<string>();
    while (cur && !seen.has(String(cur.id))) {
      seen.add(String(cur.id));
      const stamp = stampsOf(cur.normalization, [key])[key];
      if (stamp) { out[key] = stamp; break; }
      const prev = earlier(cur);
      if (!prev || (earningsOf(prev.normalization) ?? {})[key] !== value) {
        const created = isoOf(cur.createdAt);
        if (created) out[key] = created;
        break;
      }
      cur = prev;
    }
  }
  return out;
}

/**
 * The analysis → CIM financials, every total computed here. Null when it has
 * nothing usable. `history` (the deal's analyses) dates the bridge's last change.
 */
export function buildCimFinancials(analysis: AnalysisLike | null | undefined, history?: AnalysisLike[] | null): CimFinancials | null {
  if (!analysis) return null;
  const row = normalizeFinancialAnalysisRow({ ...(analysis as Record<string, unknown>) }) as Record<string, any>;
  const table = row.reclassifiedPnl as UiReclassifiedTable | null;
  const norm = row.normalization as UiNormalization | null;
  const hasTable = !!table && Array.isArray(table.rows) && table.rows.length > 0 && Array.isArray(table.years);
  const hasNorm = !!norm && Array.isArray(norm.addbacks);
  const balanceSheet = (row.reclassifiedBalanceSheet ?? null) as UiReclassifiedTable | null;
  const wc = cimWorkingCapital(row.workingCapital as UiWorkingCapital | null, balanceSheet);
  const debt = cimDebt(balanceSheet);
  if (!hasTable && !hasNorm && !wc && !debt) return null;
  const pnl = hasTable ? pnlByYear(table!, norm?.netIncome ?? {}) : null;
  const years = Array.from(new Set([...(hasTable ? table!.years : []), ...(hasNorm ? norm!.years ?? [] : [])])).sort();
  const changedAt = hasNorm ? earningsChangedAt(analysis, history ?? []) : {};
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
    workingCapital: wc,
    ...(debt ? { debt } : {}),
    ...(Object.keys(changedAt).length > 0 ? { bridgeChangedAt: changedAt } : {}),
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
 * The analysis's figures are a reclassification of the statements: one-time
 * items are taken out of cost of sales and operating expenses and shown on
 * their own. A table copied from them then differs line by line from the
 * statements as issued — Ridgeline's FY2024 cost of sales $6,804,000 and
 * gross profit $3,011,000 against the compiled statements' $6,868,000 and
 * $2,947,000 (the $64,000 crane rebuild moved) — and the writer labelled it
 * "Compiled financial statements". This is the footnote that says so; null
 * when the analysis moved nothing.
 */
export function reclassificationNote(fin: CimFinancials | null | undefined): string | null {
  if (!fin?.pnl) return null;
  const years = new Set(Object.keys(fin.pnl));
  const oneTime = fin.lines
    .filter((l) => /non-?recurring|one-?time/i.test(l.category))
    .map((l) => {
      const ys = Object.keys(l.values).filter((y) => years.has(y) && l.values[y]).sort();
      return ys.length ? `${l.name.replace(/\s*\([^)]*\)\s*$/, "").trim()} (${ys.map((y) => `FY${y} ${money(Math.abs(l.values[y]))}`).join(", ")})` : null;
    })
    .filter((x): x is string => !!x);
  if (oneTime.length === 0) return null;
  return `Figures as reclassified in the financial analysis: one-time items — ${oneTime.join("; ")} — are shown apart from cost of sales and operating expenses, so these lines can differ from the financial statements as issued.`;
}

/** Does a financial table show the analysis's cost of sales or gross profit (so its reclassified lines)? */
function showsAnalysisLines(layoutData: Record<string, unknown>, fin: CimFinancials): boolean {
  if (!fin.pnl) return false;
  const targets = Object.values(fin.pnl).flatMap((p) => [p.cogs, p.grossProfit, p.operatingExpenses]).filter((v): v is number => typeof v === "number" && v !== 0);
  const rows = [...(Array.isArray(layoutData.rows) ? layoutData.rows : []), ...(Array.isArray(layoutData.normalizedRows) ? layoutData.normalizedRows : [])];
  return rows.some((r) => {
    const label = String((r as { label?: unknown })?.label ?? "");
    if (!/cost of (?:sales|goods|revenue|services)|cogs|direct costs?|gross (?:profit|margin)|operating expenses|opex/i.test(label)) return false;
    const values = Array.isArray((r as { values?: unknown })?.values) ? ((r as { values: unknown[] }).values) : [];
    return values.some((v) => {
      const n = Number(String(v ?? "").replace(/[$,()\s]/g, ""));
      return Number.isFinite(n) && n !== 0 && targets.some((t) => Math.abs(Math.abs(n) - Math.abs(t)) <= 1);
    });
  });
}

/**
 * A financial table built from the analysis's reclassified lines, with the
 * footnote saying they are reclassified (unless it already says so).
 */
export function withReclassificationNote(layoutType: string, layoutData: Record<string, unknown>, fin: CimFinancials | null | undefined): Record<string, unknown> {
  if (layoutType !== "financial_table" || !fin) return layoutData;
  const note = reclassificationNote(fin);
  if (!note || !showsAnalysisLines(layoutData, fin)) return layoutData;
  const footnotes = Array.isArray(layoutData.footnotes) ? (layoutData.footnotes as unknown[]).map(String) : [];
  if (footnotes.some((f) => /reclassif/i.test(f))) return layoutData;
  return { ...layoutData, footnotes: [...footnotes, note] };
}

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
  const reclassified = reclassificationNote(fin);
  if (reclassified) {
    out.push(
      `These are the analysis's RECLASSIFIED figures, not the statements' own lines. A statement table built from them never says it shows the financial statements as issued (no "per the compiled statements" caption or footnote); it carries this footnote: "${reclassified}"`,
    );
  }
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

  if (fin.bridgeWithheld) out.push(`\nEBITDA / SDE BRIDGE: ${fin.bridgeWithheld}`);
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

  out.push(...workingCapitalLines(fin.workingCapital));
  out.push(...debtLines(fin.debt));
  return out.filter((l) => l !== "").join("\n");
}

/** "2024-12-31" → "December 31, 2024"; anything else as written. */
export function periodLabel(period: string | null | undefined): string {
  const p = String(period ?? "").trim();
  const m = /^((?:19|20)\d{2})-(\d{2})-(\d{2})$/.exec(p);
  if (!m) return p;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The working-capital part of the block: cash-free, debt-free lines, what
 * was left out and why, year-end history on the same basis, the peg, and
 * the difference from the peg computed here (the writer never works out a
 * "shortfall" itself).
 */
export function workingCapitalLines(wc: CimWorkingCapital | null | undefined): string[] {
  if (!wc) return [];
  const out: string[] = [];
  const asOf = wc.asOfPeriod ? periodLabel(wc.asOfPeriod) : "";
  out.push(`\nWORKING CAPITAL${asOf ? ` (as of ${asOf})` : ""} — cash-free, debt-free: the same basis as the peg:`);
  for (const i of wc.currentAssets) out.push(`Current asset — ${i.name}: ${money(i.amount)}`);
  for (const i of wc.currentLiabilities) out.push(`Current liability — ${i.name}: ${money(i.amount)}`);
  out.push(`Net working capital (cash-free, debt-free): ${money(wc.netWorkingCapital)}`);
  if (wc.excluded.length > 0) {
    out.push(
      `Not part of net working capital (settled at closing on a cash-free, debt-free basis — never list these as working-capital lines, never add them into net working capital, never compare them with the peg): ${wc.excluded.map((i) => `${i.name} ${money(i.amount)}`).join("; ")}`,
    );
  }
  const history = Object.entries(wc.history ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (history.length > 1) out.push(`Year-end net working capital (cash-free, debt-free): ${history.map(([y, v]) => `${y} ${money(v)}`).join(" · ")}`);
  const tax = wc.withIncomeTaxes;
  if (tax) {
    const taxHistory = Object.entries(tax.history ?? {}).sort(([a], [b]) => a.localeCompare(b));
    out.push(
      `The figures above leave income taxes payable (${money(tax.incomeTaxesPayable)}) out, as settled at closing; counted as working capital, as some purchase agreements do, net working capital${asOf ? ` at ${asOf}` : ""} is ${money(tax.netWorkingCapital)}${taxHistory.length > 1 ? ` (year-end: ${taxHistory.map(([y, v]) => `${y} ${money(v)}`).join(" · ")})` : ""}. Use one treatment throughout and say which.`,
    );
  }
  const where = asOf ? `at ${asOf}` : "at the date above";
  if (typeof wc.pegAmount === "number") {
    out.push(`Working capital peg (target): ${money(wc.pegAmount)}${wc.pegBasis ? ` — ${wc.pegBasis}` : ""}`);
    const gap = (nwc: number) => {
      const d = Math.round(nwc - wc.pegAmount!);
      return Math.abs(d) < 1 ? "equal to the peg" : `${money(Math.abs(d))} ${d > 0 ? "above" : "below"} the peg`;
    };
    // Whether the peg counts income taxes is the purchase agreement's call:
    // both differences are given when the treatments disagree.
    const alt = tax && !/income\s+tax/i.test(wc.pegBasis ?? "") && gap(tax.netWorkingCapital) !== gap(wc.netWorkingCapital) ? ` (${gap(tax.netWorkingCapital)} with income taxes payable counted as working capital)` : "";
    out.push(
      `Net working capital ${where} was ${gap(wc.netWorkingCapital)}${alt}. The closing adjustment is measured on the balances at closing, not these — never promise buyers a shortfall or an excess.`,
    );
  } else if (wc.pegWithheld) {
    out.push(
      `No working capital peg can be stated: ${wc.pegWithheld.reason}. Never state a peg or a target working capital, and never compare net working capital with one — describe the closing adjustment only as a mechanism.`,
    );
  }
  return out;
}

/** Year-end debt from the balance sheet: every debt figure is tied to its year. */
export function debtLines(debt: CimDebt | null | undefined): string[] {
  if (!debt) return [];
  const out = ["\nDEBT AT YEAR END (balance sheet — a debt or credit-line balance is always stated with its year; an undated debt figure in the facts that matches another year's balance is that year's):"];
  const term = yearRow("Term debt incl. current portion", debt.years, (y) => debt.termDebt[y]);
  if (term) out.push(term);
  const cur = yearRow("of which current portion", debt.years, (y) => debt.currentPortion[y]);
  if (cur) out.push(cur);
  const bank = yearRow("Drawn on the operating line / bank indebtedness", debt.years, (y) => debt.bankIndebtedness[y]);
  if (bank) out.push(bank);
  return out.length > 1 ? out : [];
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
export function cimGrowth(
  fin: CimFinancials | null | undefined,
  canon?: { adjustedEbitda: Record<string, number>; sde: Record<string, number> } | null,
): CimGrowth[] {
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
  // Earnings growth from the CIM's own figures (earnings-canon) when given —
  // a bridge the broker's figure overruled is no basis for a growth rate.
  if (canon) {
    series("Adjusted EBITDA", canon.adjustedEbitda);
    series("SDE", canon.sde);
    return out;
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
