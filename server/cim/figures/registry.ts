/**
 * registry — the CIM's figures: line × year → the value the CIM shows, from
 * the financial analysis the CIM uses (cim-financials.ts buildCimFinancials)
 * and, for lines the analysis lacks, the deal's facts. Pure.
 *
 * Totals carry their components with the sign they add to the total (an
 * expense line in a profit total is −1), so a movement can be broken down
 * (D7) and DD "what's in it" can list them.
 */
import type { CimFinancials } from "../cim-financials";
import type { FigureRegistry, RegistryFigure } from "@shared/figure-anchors";
import { AS_ISSUED, FIGURE_LINES, figureKey, lineSlug, standardLine, type LineId, type StandardLineId } from "@shared/figure-lines";
import { parseShownAmount } from "@shared/figure-anchors";

/** Analysis categories → the total they make up. */
const CATEGORY_TOTAL: Record<string, StandardLineId> = {
  Revenue: "revenue",
  COGS: "costOfSales",
  "Operating Expenses": "operatingExpenses",
  "Owner Compensation": "operatingExpenses",
  "Non-Recurring": "nonRecurring",
  "Other Income": "otherIncome",
  Depreciation: "amortization",
  Interest: "interest",
  Taxes: "incomeTaxes",
};
const EXPENSE_CATEGORIES = new Set(["COGS", "Operating Expenses", "Owner Compensation", "Non-Recurring", "Other Expense", "Depreciation", "Interest", "Taxes"]);

/** Which atomic lines (by category) make up each derived total, and with what sign. */
const DERIVED: Partial<Record<StandardLineId, Array<[string, 1 | -1]>>> = {
  grossProfit: [["Revenue", 1], ["COGS", -1]],
  ebitda: [["Revenue", 1], ["COGS", -1], ["Operating Expenses", -1], ["Owner Compensation", -1], ["Non-Recurring", -1]],
  netIncome: [
    ["Revenue", 1], ["COGS", -1], ["Operating Expenses", -1], ["Owner Compensation", -1], ["Non-Recurring", -1],
    ["Other Income", 1], ["Other Expense", -1], ["Depreciation", -1], ["Interest", -1], ["Taxes", -1],
  ],
};

/**
 * `statements` (optional): the statements-as-issued values per fiscal year
 * (sources.ts statementValuesByYear). Where the analysis reclassified a line
 * (one-time items shown on their own), the statements' own figure is added as
 * the line's "@statements" variant, so a CIM table copied from the
 * statements anchors too.
 */
export function figureRegistry(
  fin: CimFinancials | null | undefined,
  facts?: Record<string, unknown> | null,
  statements?: Record<string, Partial<Record<StandardLineId, number>>> | null,
): FigureRegistry {
  const reg: FigureRegistry = {};
  const put = (f: RegistryFigure) => {
    if (!Number.isFinite(f.value)) return;
    reg[f.key] = f;
  };

  // Analysis lines (atomic), with their category.
  const lines = (fin?.lines ?? []).filter((l) => l && typeof l.name === "string" && l.name.trim());
  const slugs = new Map<string, number>();
  const lineIdOf = lines.map((l) => {
    let id = lineSlug(l.name);
    const n = slugs.get(id) ?? 0;
    slugs.set(id, n + 1);
    if (n > 0) id = `${id}-${n + 1}` as LineId;
    return id;
  });
  lines.forEach((l, i) => {
    for (const [year, value] of Object.entries(l.values ?? {})) {
      if (typeof value !== "number" || !/^\d{4}$/.test(year)) continue;
      put({
        key: figureKey(lineIdOf[i], year), line: lineIdOf[i], lineLabel: l.name.trim(), year,
        value: EXPENSE_CATEGORIES.has(l.category) ? Math.abs(value) : value,
        total: false, category: l.category, expense: EXPENSE_CATEGORIES.has(l.category),
      });
    }
  });
  const atomicIn = (category: string, year: string) =>
    lines.map((l, i) => ({ l, id: lineIdOf[i] })).filter(({ l }) => l.category === category && typeof l.values?.[year] === "number").map(({ id }) => figureKey(id, year));

  // Totals from the analysis's P&L (the same arithmetic the CIM writer copies).
  for (const [year, p] of Object.entries(fin?.pnl ?? {})) {
    const comps = (line: StandardLineId): RegistryFigure["components"] => {
      const derived = DERIVED[line];
      if (derived) return derived.flatMap(([cat, sign]) => atomicIn(cat, year).map((key) => ({ key, sign })));
      const cats = Object.entries(CATEGORY_TOTAL).filter(([, t]) => t === line).map(([c]) => c);
      return cats.flatMap((c) => atomicIn(c, year).map((key) => ({ key, sign: 1 as const })));
    };
    const add = (line: StandardLineId, value: number | null | undefined, opts: { skipZero?: boolean } = {}) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      if (opts.skipZero && Math.abs(value) < 1) return;
      const def = standardLine(line)!;
      const components = comps(line);
      put({
        key: figureKey(line, year), line, lineLabel: def.label, year, value: def.expense ? Math.abs(value) : value,
        total: def.total || (components?.length ?? 0) > 1, ...(components && components.length > 0 ? { components } : {}), expense: def.expense,
      });
    };
    add("revenue", p.revenue);
    add("costOfSales", p.cogs);
    add("grossProfit", p.grossProfit);
    add("operatingExpenses", p.operatingExpenses);
    add("nonRecurring", p.nonRecurring, { skipZero: true });
    add("ebitda", p.ebitda);
    add("otherIncome", p.otherIncome, { skipZero: true });
    add("amortization", p.depreciation, { skipZero: true });
    add("interest", p.interest, { skipZero: true });
    add("incomeBeforeTax", p.incomeBeforeTaxes, { skipZero: true });
    add("incomeTaxes", p.taxes, { skipZero: true });
    add("netIncome", p.netIncomeReported ?? p.netIncomeFromRows);
  }

  // Statements-as-issued variants of the analysis's reclassified totals.
  for (const [year, values] of Object.entries(statements ?? {})) {
    for (const [lineId, value] of Object.entries(values ?? {}) as Array<[StandardLineId, number]>) {
      const base = reg[figureKey(lineId, year)];
      const def = standardLine(lineId);
      if (!base || !def || typeof value !== "number" || Math.abs(Math.abs(base.value) - Math.abs(value)) <= 1) continue;
      const comps = base.components ?? [];
      const sumOf = (cs: Array<{ key: string; sign: 1 | -1 }>) => cs.reduce((t, c) => t + c.sign * Math.abs(reg[c.key]?.value ?? 0), 0);
      const oneTime = atomicIn("Non-Recurring", year).map((key) => ({ key, sign: (def.expense ? 1 : -1) as 1 | -1 }));
      const withOneTime = [...comps, ...oneTime];
      const components = comps.length > 0 && Math.abs(Math.abs(sumOf(withOneTime)) - Math.abs(value)) <= 1 ? withOneTime
        : comps.length > 0 && Math.abs(Math.abs(sumOf(comps)) - Math.abs(value)) <= 1 ? comps : undefined;
      const line = `${lineId}${AS_ISSUED}` as LineId;
      put({
        key: figureKey(line, year), line, lineLabel: def.label, year, value: def.expense ? Math.abs(value) : value,
        total: !!components && components.length > 1, ...(components ? { components } : {}), expense: def.expense,
      });
    }
  }

  // Lines the analysis lacks, from the deal's facts (by-year maps).
  for (const line of FIGURE_LINES) {
    for (const factKey of line.factKeys) {
      const map = facts?.[factKey];
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      for (const [year, raw] of Object.entries(map as Record<string, unknown>)) {
        if (!/^\d{4}$/.test(year) || reg[figureKey(line.id, year)]) continue;
        const shown = parseShownAmount(raw);
        if (!shown || shown.value === 0) continue;
        put({ key: figureKey(line.id, year), line: line.id, lineLabel: line.label, year, value: line.expense ? Math.abs(shown.value) : shown.value, total: false, expense: line.expense });
      }
    }
  }
  return reg;
}

/** The registry figures of one year, by line. */
export function figuresOfYear(reg: FigureRegistry, year: string): RegistryFigure[] {
  return Object.values(reg).filter((f) => f.year === year);
}

/** Revenue of a year (the size rule's "0.5% of revenue"). */
export function revenueOf(reg: FigureRegistry, year: string): number | null {
  return reg[figureKey("revenue", year)]?.value ?? null;
}
