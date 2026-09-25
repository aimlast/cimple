/**
 * Deterministic rules applied to every financial analysis after the model
 * answers — the arithmetic and accounting a CIM figure depends on is never
 * left to the model alone.
 *
 *  1. Distributions are not add-backs. Dividends, owner draws and
 *     shareholder-loan repayments come out of after-tax profit on the balance
 *     sheet; there is nothing on the P&L to add back. (Ridgeline: a $60K
 *     Class D dividend was added to owner comp — $268K — and inflated SDE.)
 *     A recovery or clawback is a timing item, not income to strip out.
 *  2. Working capital is cash-free and debt-free: cash, bank debt, the
 *     current portion of long-term debt, shareholder loans and income taxes
 *     are out of NWC, and a single period's NWC is never the peg.
 *     (Beacon: cash of $871,410 counted in NWC "excluding cash", and the peg
 *     set equal to it.)
 *  3. EBITDA and SDE are computed in code from their components and stored
 *     as the canonical figures; any insight or note that states a different
 *     amount is flagged with the computed one. (Beacon: EBITDA stated as
 *     $679,312 while its own components sum to $660,252.)
 *
 * Pure — used by the analyzer after each run and by the PATCH route after a
 * broker edit. Broker decisions (custom add-backs, approval overrides) are
 * never undone.
 */
import type { UiAddback, UiInsights, UiInsight, UiNormalization, UiWorkingCapital, UiWorkingCapitalItem } from "./shape";
import { numberTokens } from "../cim/discrepancy-filter";

const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// ── 1. Add-back rules ──

export const DISTRIBUTION_RE =
  /\b(?:dividends?|owner'?s?\s+draws?|draws?\s+(?:by|to)\s+(?:the\s+)?(?:owner|shareholders?)|shareholder\s+draws?|distributions?(?:\s+to\s+(?:owners?|shareholders?))?|(?:repayments?\s+of\s+)?shareholder(?:'s)?\s+loans?\s+(?:repaid|repayments?)|repayments?\s+of\s+(?:the\s+)?shareholder(?:'s)?\s+loans?)\b/i;
export const RECOVERY_RE = /\b(?:recover(?:y|ies|ed)|claw-?backs?|post[- ]payment\s+(?:recovery|review|audit)|recoupments?)\b/i;

const DIVIDEND_AMOUNT_RES = [
  /(\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?)\s+(?:[A-Za-z-]+\s+){0,3}dividends?\b/i,
  /\bdividends?\s+(?:of\s+|totall?ing\s+|paid\s+|declared\s+)?(?:[A-Za-z-]+\s+){0,2}(\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?)/i,
];

function dividendAmount(text: string): number | null {
  for (const re of DIVIDEND_AMOUNT_RES) {
    const m = text.match(re);
    if (m) {
      const t = numberTokens(m[1])[0];
      if (t && !t.pct && t.value > 0) return t.value;
    }
  }
  return null;
}

/** Owner-decided add-backs (custom, or approval toggled by the broker) are never rewritten. */
const brokerOwned = (ab: UiAddback) => ab.custom === true || ab.approvedOverride === true;

export function applyAddbackRules(n: UiNormalization | null): UiNormalization | null {
  if (!n) return n;
  const notes: string[] = [...(n.notes ?? [])];
  const addbacks = (Array.isArray(n.addbacks) ? n.addbacks : []).map((ab) => {
    if (brokerOwned(ab)) return ab;
    const out: UiAddback = { ...ab, amounts: { ...ab.amounts } };
    const description = out.description ?? "";
    // A line that IS a distribution.
    if (DISTRIBUTION_RE.test(out.label)) {
      if (out.approved) {
        out.approved = false;
        out.description = `Not an add-back — dividends and owner draws are distributions of after-tax profit, not P&L expenses.${description ? ` ${description}` : ""}`;
        notes.push(`"${out.label}" is a distribution to the shareholder, not an expense on the P&L, so it is not added back. It is listed for reference only.`);
      }
      return out;
    }
    // Owner compensation that folded a dividend in: take the dividend out.
    if (DISTRIBUTION_RE.test(description) && (out.category === "owner_comp" || /owner|shareholder|officer/i.test(out.label))) {
      const d = dividendAmount(description);
      const years = Object.keys(out.amounts).filter((y) => (out.amounts[y] ?? 0) >= (d ?? Infinity) * 0.98);
      const named = years.filter((y) => description.includes(y));
      const target = named.length > 0 ? named : years.length === 1 ? years : [];
      if (d && target.length > 0) {
        for (const y of target) out.amounts[y] = Math.round(out.amounts[y] - d);
        out.description = `${description} — the ${fmt(d)} dividend is excluded (a distribution, not compensation).`;
        notes.push(`Owner compensation add-back "${out.label}" included a ${fmt(d)} dividend; dividends are distributions of after-tax profit and are not added back, so it was removed (${target.join(", ")}).`);
      } else {
        out.confidence = "low";
        notes.push(`"${out.label}" mentions a dividend or draw. Dividends and draws are distributions, not add-backs — check that none is included in the amount.`);
      }
    }
    // A clawback/recovery removed as if it were income.
    if (RECOVERY_RE.test(`${out.label} ${description}`) && Object.values(out.amounts).some((v) => v < 0) && out.approved) {
      out.approved = false;
      out.description = `Not removed as income — a recovery or clawback is a timing item.${description ? ` ${description}` : ""}`;
      notes.push(`"${out.label}" is a recovery/clawback (a timing item), not income; it is not deducted from earnings.`);
    }
    return out;
  });
  return { ...n, addbacks, notes: Array.from(new Set(notes)) };
}

// ── 2. Working capital ──

const CASH_RE = /\b(?:cash|bank\s+balances?|cash\s+equivalents?|petty\s+cash|term\s+deposits?|gics?|short[- ]term\s+investments?|marketable\s+securities)\b/i;
const EXCLUDED_ASSET_RE =
  /\b(?:due\s+from\s+(?:shareholders?|related|directors?|owners?|affiliates?)|shareholder(?:'s)?\s+(?:loans?|advances?)(?:\s+receivable)?|loans?\s+to\s+shareholders?|income\s+tax(?:es)?\s+(?:receivable|recoverable|refundable)|refundable\s+(?:income\s+)?tax)\b/i;
const DEBT_RE =
  /\b(?:bank\s+(?:indebtedness|loans?|overdraft|debt)|(?:operating\s+)?lines?\s+of\s+credit|operating\s+(?:line|loan)|credit\s+facilit(?:y|ies)|current\s+portion|long[- ]term\s+debt|term\s+loans?|shareholder(?:'s)?\s+loans?|due\s+to\s+(?:shareholders?|related|directors?|owners?|affiliates?)|advances?\s+from\s+shareholders?|income\s+tax(?:es)?\s+payable|corporate\s+(?:income\s+)?tax(?:es)?\s+payable|dividends?\s+payable|(?:capital|finance)\s+lease\s+obligations?|notes?\s+payable|equipment\s+loans?|vehicle\s+loans?)\b/i;

export function applyWorkingCapitalRules(wc: UiWorkingCapital | null): UiWorkingCapital | null {
  if (!wc) return wc;
  const sum = (xs: UiWorkingCapitalItem[]) => xs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const originalNwc = Number.isFinite(wc.netWorkingCapital) ? wc.netWorkingCapital : sum(wc.currentAssets) - sum(wc.currentLiabilities);
  const removed: UiWorkingCapitalItem[] = [];
  // "Accounts receivable" etc. never match; a row named for cash or a
  // shareholder balance does.
  const currentAssets = wc.currentAssets.filter((i) => {
    const out = (CASH_RE.test(i.name) && !/receivable/i.test(i.name)) || EXCLUDED_ASSET_RE.test(i.name);
    if (out) removed.push(i);
    return !out;
  });
  const currentLiabilities = wc.currentLiabilities.filter((i) => {
    const out = DEBT_RE.test(i.name);
    if (out) removed.push(i);
    return !out;
  });
  const notes = [...(wc.notes ?? [])];
  let netWorkingCapital = wc.netWorkingCapital;
  if (removed.length > 0) {
    netWorkingCapital = sum(currentAssets) - sum(currentLiabilities);
    notes.push(
      `Net working capital is on a cash-free, debt-free basis: cash, bank debt, the current portion of long-term debt, shareholder loans and income taxes are excluded. Removed: ${removed.map((i) => `${i.name} (${fmt(i.amount)})`).join(", ")}.`,
    );
  }
  // A peg is a normalized trailing average — never one period's NWC.
  const isSinglePeriod = (v: number | null | undefined) =>
    typeof v === "number" && [originalNwc, netWorkingCapital].some((n) => Math.abs(v - n) <= Math.max(1, Math.abs(n) * 0.001));
  let pegAmount = wc.pegAmount ?? null;
  let targetNwc = wc.targetNwc ?? null;
  if (isSinglePeriod(pegAmount) || isSinglePeriod(targetNwc)) {
    pegAmount = isSinglePeriod(pegAmount) ? null : pegAmount;
    targetNwc = isSinglePeriod(targetNwc) ? null : targetNwc;
    notes.push("A working-capital peg is normally a trailing-twelve-month average of monthly net working capital; one period's balance isn't a peg. Set it once monthly balances are available.");
  }
  // The peg IS the target NWC. A different "peg" is usually the closing
  // adjustment (actual minus target) put in the wrong place.
  if (targetNwc !== null && pegAmount !== null && Math.abs(pegAmount - targetNwc) > Math.max(1, Math.abs(targetNwc) * 0.01)) {
    notes.push(`The peg is the target net working capital (${fmt(targetNwc)}); ${fmt(pegAmount)} was shown as the peg and has been replaced — any difference between the closing balance and the target is the closing adjustment, not the peg.`);
    pegAmount = targetNwc;
  }
  return { ...wc, currentAssets, currentLiabilities, netWorkingCapital, pegAmount, targetNwc, notes: Array.from(new Set(notes)) };
}

// ── 3. Canonical EBITDA / SDE ──

export interface CanonicalEarnings {
  /** Net income + interest + taxes + depreciation/amortization (approved add-backs of those kinds). */
  reportedEbitda: Record<string, number>;
  /** Net income + every approved add-back that applies to EBITDA. */
  adjustedEbitda: Record<string, number>;
  /** Adjusted EBITDA + approved owner-specific (SDE) add-backs. */
  sde: Record<string, number>;
  latestYear: string | null;
}

const EBITDA_COMPONENT_RE = /\b(?:interest|income\s+tax(?:es)?|taxes|tax\s+expense|provision\s+for\s+(?:income\s+)?tax(?:es)?|depreciation|amorti[sz]ation|d\s*&\s*a|cca)\b/i;

export function computeCanonicalEarnings(n: UiNormalization | null): CanonicalEarnings | null {
  if (!n) return null;
  const years = (n.years?.length ? n.years : Object.keys(n.netIncome ?? {})).filter((y) => Number.isFinite(n.netIncome?.[y]));
  if (years.length === 0) return null;
  const out: CanonicalEarnings = { reportedEbitda: {}, adjustedEbitda: {}, sde: {}, latestYear: years[years.length - 1] };
  for (const y of years) {
    const ni = n.netIncome[y];
    let reported = ni;
    let adjusted = ni;
    let sde = ni;
    for (const ab of Array.isArray(n.addbacks) ? n.addbacks : []) {
      if (!ab.approved) continue;
      const v = Number(ab.amounts?.[y]) || 0;
      if (ab.type === "sde") {
        sde += v;
        continue;
      }
      adjusted += v;
      sde += v;
      if (EBITDA_COMPONENT_RE.test(ab.label)) reported += v;
    }
    out.reportedEbitda[y] = Math.round(reported);
    out.adjustedEbitda[y] = Math.round(adjusted);
    out.sde[y] = Math.round(sde);
  }
  return out;
}

/** The normalization with its canonical figures stored alongside (computed + latest-year headline). */
export function withCanonicalEarnings<T extends UiNormalization | null>(n: T): T {
  if (!n) return n;
  const computed = computeCanonicalEarnings(n);
  const base = { ...(n as UiNormalization) } as UiNormalization & Record<string, unknown>;
  if (!computed) {
    delete base.computed;
    delete base.adjustedEbitda;
    delete base.adjustedSde;
    return base as T;
  }
  const y = computed.latestYear!;
  return {
    ...base,
    computed,
    adjustedEbitda: computed.adjustedEbitda[y],
    adjustedSde: computed.sde[y],
  } as unknown as T;
}

export interface EarningsMismatch {
  where: string;
  metric: "EBITDA" | "SDE";
  year: string;
  stated: number;
  expected: number;
}

const METRIC_RE = /\b(adjusted\s+|normali[sz]ed\s+|reported\s+|unadjusted\s+)?(ebitda|sde)\b/gi;

const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:k|mm|m|million|thousand)?\b|\b\d[\d,]*(?:\.\d+)?\s*(?:k|mm|m|million|thousand)\b/gi;
const YEAR_RE = /\b(?:FY\s?)?((?:19|20)\d{2})\b/;
const ATTRIBUTION_RE = /\b(?:claim(?:s|ed)?|stated?|states|says|said|quoted|expects?|estimated by|per (?:the )?(?:seller|broker|buyer|owner|accountant|cpa)|seller'?s|owner'?s|buyer'?s|broker'?s|initially|originally|previously|earlier)\b/i;
// Words between a metric and a figure that mean the figure is something else
// ("EBITDA adds back owner salary above a $140,000 market salary").
const GAP_BREAK_RE = /[+=×*\/]|\b(?:above|below|salary|salaries|wages?|replacement|excluding|including|before|after|plus|minus|less|adds?|margin|multiple|times|x)\b/i;

interface MoneyAt { value: number; raw: string; index: number; end: number }
function moneyIn(text: string): MoneyAt[] {
  const out: MoneyAt[] = [];
  MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY_RE.exec(text)) !== null) {
    const t = numberTokens(m[0], { keepSourceLabel: true })[0];
    if (!t || t.pct || t.year) continue;
    out.push({ value: t.value, raw: m[0], index: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * EBITDA/SDE amounts stated in text that don't match the computed figures
 * (1% tolerance; rounded figures at their precision). Deliberately
 * conservative — a false "doesn't tie" erodes trust — so only clear
 * statements are read:
 *  - a worked sum ("2024 SDE = $896,410 + … = $1,777,000"): the result after
 *    the last "=", for the metric the sentence starts with;
 *  - "<metric> [for FY2024] [is/of/was/reached …] $X", with nothing between
 *    them that makes $X something else ("above a $140,000 salary", "+");
 *  - "$X EBITDA" / "$X in SDE".
 * The year is the one written next to the figure, or the sentence's only year.
 */
export function findEarningsMismatches(text: string, computed: CanonicalEarnings): Array<Omit<EarningsMismatch, "where">> {
  const out: Array<Omit<EarningsMismatch, "where">> = [];
  const years = Object.keys(computed.adjustedEbitda);
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    // Someone else's figure ("Seller initially claimed $4.1M adjusted EBITDA")
    // is reported, not stated — never "corrected".
    if (ATTRIBUTION_RE.test(sentence)) continue;
    const sentenceYears = Array.from(new Set((sentence.match(new RegExp(YEAR_RE.source, "g")) ?? []).map((y) => y.replace(/\D/g, ""))));
    const eq = sentence.lastIndexOf("=");
    const monies = moneyIn(sentence);
    METRIC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let first = true;
    while ((m = METRIC_RE.exec(sentence)) !== null) {
      const isFirst = first;
      first = false;
      const qualifier = (m[1] || "").trim().toLowerCase();
      const metric = m[2].toUpperCase() as "EBITDA" | "SDE";
      const metricEnd = m.index + m[0].length;
      let amount: MoneyAt | undefined;
      let yearText = "";
      if (eq >= 0) {
        // Worked sum: only the sentence's subject, only the result — a figure
        // right after the last "=" ("= $1,592,000"). "SDE = adjusted EBITDA +
        // …" is a definition, not a stated figure.
        if (!isFirst || eq < metricEnd) break;
        const result = monies.find((x) => x.index > eq);
        if (!result || !/^\s*(?:approximately|approx\.?|about|~)?\s*$/i.test(sentence.slice(eq + 1, result.index))) break;
        amount = result;
        yearText = sentence.slice(0, eq);
      } else {
        const next = monies.find((x) => x.index >= metricEnd);
        const gap = next ? sentence.slice(metricEnd, next.index) : "";
        const gapOk = next && gap.length <= 32 && !GAP_BREAK_RE.test(gap) && !/\d/.test(gap.replace(YEAR_RE, ""));
        if (gapOk) {
          amount = next;
          yearText = gap + sentence.slice(next!.end, next!.end + 16);
        } else {
          const prev = [...monies].reverse().find((x) => x.end <= m!.index);
          const between = prev ? sentence.slice(prev.end, m.index) : "";
          if (prev && /^\s*(?:in\s+|of\s+)?(?:adjusted\s+|normali[sz]ed\s+|reported\s+)?$/i.test(between)) {
            amount = prev;
            yearText = sentence.slice(Math.max(0, prev.index - 16), prev.index) + sentence.slice(metricEnd, metricEnd + 16);
          }
        }
      }
      if (!amount) continue;
      const near = yearText.match(YEAR_RE)?.[1];
      const statedYear = near && years.includes(near) ? near : sentenceYears.length === 1 && years.includes(sentenceYears[0]) ? sentenceYears[0] : null;
      const candidatesFor = (y: string) =>
        metric === "SDE" ? [computed.sde[y]]
        : qualifier.startsWith("adjusted") || qualifier.startsWith("normali") ? [computed.adjustedEbitda[y]]
        : qualifier ? [computed.reportedEbitda[y]]
        : [computed.reportedEbitda[y], computed.adjustedEbitda[y]];
      const checkYears = statedYear ? [statedYear] : years;
      const tolerance = (x: number) => Math.max(1000, Math.abs(x) * 0.01);
      const precision = /m\b|million/i.test(amount.raw) ? 0.05 : /k\b|thousand/i.test(amount.raw) ? 0.01 : 0;
      const value = amount.value;
      const matches = checkYears.some((y) => candidatesFor(y).some((c) => typeof c === "number" && Math.abs(c - value) <= Math.max(tolerance(c), Math.abs(c) * precision)));
      if (matches) continue;
      // Without a year, only flag when the figure matches no year at all.
      const y = statedYear ?? computed.latestYear!;
      const expected = candidatesFor(y)[0];
      if (typeof expected !== "number") continue;
      out.push({ metric, year: y, stated: value, expected });
    }
  }
  return out;
}

/**
 * Flag insights that state an EBITDA/SDE amount the normalization doesn't
 * compute: the insight keeps its text and gains a check line with the
 * computed figure (read by the broker and by the DD writer).
 */
export function flagEarningsStatements(
  insights: UiInsights | null,
  normalization: UiNormalization | null,
): { insights: UiInsights | null; mismatches: EarningsMismatch[] } {
  const computed = computeCanonicalEarnings(normalization);
  if (!insights || !computed) return { insights, mismatches: [] };
  const mismatches: EarningsMismatch[] = [];
  const fix = (list: UiInsight[] | undefined) =>
    (list ?? []).map((i) => {
      if ((i as UiInsight & { flag?: string }).flag) return i; // already checked
      const found = findEarningsMismatches(`${i.title}. ${i.detail}`, computed);
      if (found.length === 0) return i;
      found.forEach((f) => mismatches.push({ ...f, where: `Insight "${i.title}"` }));
      const check = found.map((f) => `the normalization computes ${f.year} ${f.metric} as ${fmt(f.expected)}, not ${fmt(f.stated)}`).join("; ");
      const flagged: UiInsight & { flag?: string } = { ...i, detail: `${i.detail} (Check: ${check}.)`, flag: check };
      return flagged;
    });
  return {
    insights: { positive: fix(insights.positive), negative: fix(insights.negative), ...(insights.neutral ? { neutral: fix(insights.neutral) } : {}) },
    mismatches,
  };
}

/** Notes stating an EBITDA/SDE amount that doesn't tie get a correction note after them. */
export function flagEarningsNotes(normalization: UiNormalization | null): UiNormalization | null {
  const computed = computeCanonicalEarnings(normalization);
  if (!normalization || !computed) return normalization;
  const notes: string[] = [];
  for (const note of normalization.notes ?? []) {
    notes.push(note);
    if (/^Check:/.test(note)) continue;
    for (const f of findEarningsMismatches(note, computed)) {
      notes.push(`Check: the note above states ${f.year} ${f.metric} as ${fmt(f.stated)}; the add-backs listed here compute ${fmt(f.expected)}.`);
    }
  }
  return { ...normalization, notes: Array.from(new Set(notes)) };
}
