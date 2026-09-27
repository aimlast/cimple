/**
 * Signs on a reclassified income statement — one rule for the server's net
 * income (financial/shape.ts computePnlNetIncome), the CIM's statement
 * (cim/cim-financials.ts) and the broker's Income Statement table.
 *
 * Expenses are written as positive amounts (the analysis prompt's
 * convention), so a NEGATIVE expense is money coming back: "Income taxes
 * (recovery) −12,000" in a loss or carry-back year reduces expenses and adds
 * to net income. Taking the absolute value of every expense category (the
 * old rule) turned that recovery into $12,000 of tax: net income came out
 * $24,000 below the reported figure, the year was flagged as not tying, and
 * the CIM printed a tax expense where the statements show a recovery.
 *
 * The absolute value is right only when the model wrote a category the
 * other way round — every amount in it negative (a whole statement of
 * negative expenses, or one category of them) and no row named as a
 * recovery, refund, credit or gain. Pure.
 */
export const PNL_INCOME_CATEGORIES: ReadonlySet<string> = new Set(["Revenue", "Other Income"]);

interface PnlRowLike {
  name?: string | null;
  category: string;
  values: Record<string, number | null | undefined>;
}

/** A row whose negative amount is money coming back, not a sign convention. */
const RECOVERY_RE = /\b(?:recover(?:y|ies|ed)|refunds?|refundable|credits?|rebates?|reversals?|gains?|benefits?|reimburse(?:d|ments?))\b/i;

/**
 * Per expense category: +1 when its amounts are written positive (the
 * convention: a negative amount is a recovery), −1 when the whole category
 * is written negative (its amounts are expenses the other way round).
 */
export function expenseCategorySigns(rows: PnlRowLike[]): Record<string, 1 | -1> {
  const byCat = new Map<string, PnlRowLike[]>();
  for (const r of rows) {
    if (!r || PNL_INCOME_CATEGORIES.has(r.category) || r.category === "Excluded") continue;
    byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  }
  // The table's own convention: most expense amounts positive, or most negative.
  let pos = 0;
  let neg = 0;
  // (A row named as a recovery says nothing about the convention — its minus is real.)
  byCat.forEach((list) => list.filter((r) => !RECOVERY_RE.test(r.name ?? "")).forEach((r) => Object.values(r.values ?? {}).forEach((v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v === 0) return;
    if (v > 0) pos++; else neg++;
  })));
  const tableSign: 1 | -1 = neg > pos ? -1 : 1;
  const out: Record<string, 1 | -1> = {};
  byCat.forEach((list, cat) => {
    const vals = list.flatMap((r) => Object.values(r.values ?? {})).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v !== 0);
    const allNegative = vals.length > 0 && vals.every((v) => v < 0);
    const namedRecovery = list.some((r) => RECOVERY_RE.test(r.name ?? ""));
    out[cat] = tableSign === -1 ? -1 : allNegative && !namedRecovery ? -1 : 1;
  });
  return out;
}

/** A category's expense for a year as a positive cost (negative = a net recovery). */
export function categoryExpense(rows: PnlRowLike[], category: string, year: string, signs: Record<string, 1 | -1> = expenseCategorySigns(rows)): number {
  const sign = signs[category] ?? 1;
  return rows
    .filter((r) => r.category === category)
    .reduce((s, r) => s + (typeof r.values?.[year] === "number" && Number.isFinite(r.values[year]) ? sign * (r.values[year] as number) : 0), 0);
}

/** Net income from the rows: Revenue + Other Income − each expense category (signed as above); Excluded rows don't count. */
export function pnlNetIncome(rows: PnlRowLike[], years: string[]): Record<string, number> {
  const signs = expenseCategorySigns(rows);
  const out: Record<string, number> = {};
  for (const year of years) {
    let total = 0;
    const cats = new Set(rows.map((r) => r.category));
    cats.forEach((cat) => {
      const has = rows.some((r) => r.category === cat && r.values?.[year] !== undefined && r.values?.[year] !== null);
      if (!has || cat === "Excluded") return;
      if (PNL_INCOME_CATEGORIES.has(cat)) {
        total += rows.filter((r) => r.category === cat).reduce((s, r) => s + (Number(r.values?.[year]) || 0), 0);
      } else {
        total -= categoryExpense(rows, cat, year, signs);
      }
    });
    out[year] = total;
  }
  return out;
}
