/**
 * Deterministic rules applied to every financial analysis after the model
 * answers — the arithmetic and accounting a CIM figure depends on is never
 * left to the model alone.
 *
 *  1. Distributions are not add-backs. Dividends, owner draws and
 *     shareholder-loan repayments come out of after-tax profit on the balance
 *     sheet; there is nothing on the P&L to add back. (Ridgeline: a $60K
 *     Class D dividend was added to owner comp — $268K — and inflated SDE.)
 *     A clawback the business repaid is a cost, never income to strip out.
 *     Owner compensation is split: the part above a market salary counts
 *     for EBITDA and SDE, the market salary for SDE only — SDE adds back the
 *     owner's full pay, adjusted EBITDA only the excess.
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

/**
 * A line that IS a payment to the owners out of after-tax profit: dividends
 * (any class), owner/shareholder draws or distributions, shareholder-loan
 * repayments. Deliberately narrow — "Distribution centre relocation" (a
 * logistics one-off) and "Dividend income on investments" (non-operating
 * income being removed) are ordinary add-backs, not distributions.
 */
export const DISTRIBUTION_RE =
  /\b(?:dividends?(?!\s+(?:income|revenue|received|earned|receivable))|owner'?s?\s+draws?|draws?\s+(?:by|to)\s+(?:the\s+)?(?:owners?|shareholders?|partners?)|(?:shareholder|owner|partner|member)s?'?\s+(?:draws?|distributions?)|distributions?\s+(?:paid\s+)?to\s+(?:the\s+)?(?:owners?|shareholders?|partners?|members?)|repayments?\s+of\s+(?:the\s+)?shareholder(?:'s)?\s+loans?|shareholder(?:'s)?\s+loans?\s+(?:repaid|repayments?))\b/i;
/** A label that is nothing but "Distributions" / "Distributions paid". */
const BARE_DISTRIBUTION_RE = /^\s*(?:distributions?|draws?)(?:\s+paid)?\s*$/i;
/** Money coming IN (income, a gain) — never a distribution. */
const INCOME_WORD_RE = /\b(?:income|revenue|received|earned|gain|interest\s+on)\b/i;

export function isDistributionLine(ab: Pick<UiAddback, "label" | "amounts">): boolean {
  const label = ab.label ?? "";
  if (!DISTRIBUTION_RE.test(label) && !BARE_DISTRIBUTION_RE.test(label)) return false;
  if (INCOME_WORD_RE.test(label)) return false;
  // A distribution added back is always positive; a negative line is income
  // being removed.
  return !Object.values(ab.amounts ?? {}).some((v) => Number(v) < 0);
}

/**
 * A clawback — money the business had to PAY BACK (a drug-plan post-payment
 * audit, a recoupment). Removing it as if it were income double-counts it.
 * Recoveries the business RECEIVED (insurance proceeds, a settlement, a
 * one-time gain) are the opposite: non-recurring income, correctly removed
 * with a negative add-back.
 */
export const CLAWBACK_RE =
  /\b(?:claw-?backs?|recoupments?|post[- ]payment\s+(?:recover(?:y|ies)|reviews?|audits?|adjustments?)|audit\s+(?:recover(?:y|ies)|repayments?|clawbacks?)|(?:odb|drug\s+plan|ministry|government|payer|plan)\s+(?:audit\s+)?recover(?:y|ies))\b/i;
const RECEIVED_RE = /\b(?:insurance|settlement|proceeds|gain|received|recovered\s+from|reimburse(?:d|ment)|refund(?:ed)?\s+(?:from|to\s+the\s+company))\b/i;

export function isClawbackLine(ab: Pick<UiAddback, "label" | "description">): boolean {
  const label = ab.label ?? "";
  if (RECEIVED_RE.test(label)) return false;
  return CLAWBACK_RE.test(label) || (CLAWBACK_RE.test(ab.description ?? "") && !RECEIVED_RE.test(ab.description ?? ""));
}

const MONEY_AMOUNT = String.raw`\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?`;
const DIVIDEND_AMOUNT_RES = [
  new RegExp(String.raw`(${MONEY_AMOUNT})\s+(?:[A-Za-z-]+\s+){0,3}dividends?\b`, "i"),
  new RegExp(String.raw`\bdividends?\s+(?:of\s+|totall?ing\s+|paid\s+|declared\s+)?(?:[A-Za-z-]+\s+){0,2}(${MONEY_AMOUNT})`, "i"),
];
const DIVIDEND_MENTION_RE = /\b(?:dividends?|owner'?s?\s+draws?|shareholder\s+draws?|distributions?\s+to\s+(?:the\s+)?(?:owners?|shareholders?))\b/i;
/** The clause says the dividend is NOT in the figure. */
const EXCLUSION_RE =
  /\b(?:exclud(?:e|es|ed|ing)|not\s+(?:included|added|counted|part\s+of|in\s+(?:the|this)|an?\s+add-?back|compensation)|isn'?t|is\s+not|are\s+not|was\s+not|never|without|separate(?:ly)?|rather\s+than|removed|taken\s+out|left\s+out|net\s+of|a\s+distribution,?\s+not)\b/i;
/** The clause says the dividend IS in the figure. */
const INCLUSION_RE = /\+|\bplus\b|\binclud(?:es|ing|ed)\b|\band\b|\bcombined\b|\btotal(?:l?ing)?\b|\bmade\s+up\s+of\b|\bconsist(?:s|ing)\s+of\b/i;

/** The clauses of a description that mention a dividend or draw. */
function dividendClauses(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+|\s+[—–]\s+|\s+-\s+|[()]/).filter((c) => DIVIDEND_MENTION_RE.test(c));
}

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

/**
 * The amounts only make sense with the dividend in them: an amount equals
 * all the description's figures summed ($180K salary, $60K dividend, $28K
 * benefits = $268K), or equals another stated figure plus the dividend.
 */
function dividendAddsUp(description: string, dividend: number, amounts: Record<string, number>): boolean {
  const figures = (description.match(new RegExp(MONEY_AMOUNT, "gi")) ?? []).map(moneyValue).filter((v): v is number => v !== null);
  const total = figures.reduce((s, v) => s + v, 0);
  const others = figures.filter((v) => v !== dividend);
  return Object.values(amounts).some((a) => {
    const n = Number(a);
    if (!Number.isFinite(n) || n <= dividend) return false;
    return (figures.length >= 2 && within(n, total)) || others.some((x) => within(n, x + dividend));
  });
}

/** Owner-decided add-backs (custom, or approval toggled by the broker) are never rewritten. */
const brokerOwned = (ab: UiAddback) => ab.custom === true || ab.approvedOverride === true;

const OWNER_WORD_RE = /\b(?:owner|shareholder|officer|president|principal|founder|proprietor|ceo)\b/i;
const PAY_WORD_RE = /\b(?:salary|salaries|wages?|compensation|comp|pay|payroll|remuneration|management\s+fees?|bonus(?:es)?|t4)\b/i;
/** A relative's pay, or someone with no role in the business — not the working owner. */
const FAMILY_RE =
  /\b(?:spouse|spousal|wife|husband|son|daughter|child(?:ren)?|family|relatives?|related[- ]part(?:y|ies)|brother|sister|mother|father|parents?|in-laws?|nephew|niece|income[- ]splitting)\b|\bnon[- ]working\b|\bno\s+(?:active\s+)?role\b|\bnot\s+(?:active|working)\s+in\b/i;

const isOwnerComp = (ab: UiAddback) => ab.category === "owner_comp" || OWNER_WORD_RE.test(ab.label);

function isFamilyOrNonWorking(ab: UiAddback): boolean {
  if (FAMILY_RE.test(ab.label)) return true;
  return !OWNER_WORD_RE.test(ab.label) && FAMILY_RE.test(ab.description ?? "");
}

/** The working owner's own pay — not a relative's, not a perk. */
export function isOwnerPayLine(ab: UiAddback): boolean {
  if (isFamilyOrNonWorking(ab)) return false;
  if (ab.ownerActualComp || ab.marketSalary !== undefined) return true;
  return PAY_WORD_RE.test(ab.label) && isOwnerComp(ab);
}

// ── Owner compensation: split into the above-market part and the market salary ──

const MARKET_BEFORE_RE = /\b(?:market|replacement|arm'?s[- ]length|fair)\b[^$\d.;=]{0,40}?(\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?)/i;
const MARKET_AFTER_RE = /(\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?)\s+(?:\w+\s+){0,2}(?:market|replacement)\b/i;
/** The label says the line is only the part above market. */
const EXCESS_LABEL_RE = /\b(?:above|over|in\s+excess\s+of|excess)\b[^.]{0,20}\b(?:market|replacement)\b|\bexcess\s+(?:owner|shareholder|officer)?\s*(?:comp|compensation|salary|wages)\b/i;

function moneyValue(raw: string): number | null {
  const t = numberTokens(raw)[0];
  return t && !t.pct && t.value > 0 ? t.value : null;
}

/** The market replacement salary stated for this owner line (structured field first, then the description). */
function marketSalaryOf(ab: UiAddback): Record<string, number> | number | null {
  const m = ab.marketSalary;
  if (typeof m === "number" && Number.isFinite(m) && m > 0) return m;
  if (m && typeof m === "object") {
    const map = Object.fromEntries(Object.entries(m).filter(([, v]) => Number.isFinite(Number(v)) && Number(v) > 0).map(([y, v]) => [y, Number(v)]));
    if (Object.keys(map).length > 0) return map;
  }
  const d = ab.description ?? "";
  const hit = d.match(MARKET_BEFORE_RE) ?? d.match(MARKET_AFTER_RE);
  return hit ? moneyValue(hit[1]) : null;
}

const within = (a: number, b: number) => Math.abs(a - b) <= Math.max(1000, Math.abs(b) * 0.01);

/**
 * The owner's actual compensation per year. Structured field first; else
 * worked out from the description's figures: the line is the above-market
 * part when its amount = X − market for a stated X, the full compensation
 * when its amount = X. With only the market figure stated, the label decides
 * ("… above market" = the excess); an unlabelled amount above the market
 * salary is the full pay ("Owner salary (T4 wages)" $180K, market $165K).
 */
function actualCompOf(ab: UiAddback, market: (y: string) => number): Record<string, number> | null {
  const given = ab.ownerActualComp;
  if (given && typeof given === "object") {
    const map = Object.fromEntries(Object.entries(given).filter(([, v]) => Number.isFinite(Number(v))).map(([y, v]) => [y, Number(v)]));
    if (Object.keys(map).length > 0) return map;
  }
  const d = ab.description ?? "";
  const figures = (d.match(new RegExp(MONEY_AMOUNT, "gi")) ?? []).map(moneyValue).filter((v): v is number => v !== null);
  const excessLabel = EXCESS_LABEL_RE.test(ab.label);
  const out: Record<string, number> = {};
  for (const [y, rawAmount] of Object.entries(ab.amounts ?? {})) {
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount)) continue;
    const m = market(y);
    const asExcess = figures.find((x) => x !== m && within(amount, x - m));
    if (asExcess !== undefined) { out[y] = asExcess; continue; }
    const asFull = figures.find((x) => x !== m && within(amount, x));
    if (asFull !== undefined && !excessLabel) { out[y] = asFull; continue; }
    if (excessLabel) { out[y] = amount + m; continue; }
    if (amount > m) { out[y] = amount; continue; }
    return null; // can't tell what this amount is
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * SDE adds back the working owner's FULL pay; adjusted EBITDA adds back only
 * what the owner is paid above a market salary for the role (a buyer who
 * hires a manager still pays the market salary). One line can't be both, so
 * it becomes two: the above-market part (type "ebitda" — counts for both
 * metrics) and the market-salary part (type "sde" — SDE only). SDE = net
 * income + the owner's actual pay; SDE − adjusted EBITDA = the market salary.
 * (Ridgeline's re-run: "$180K minus $125K market = $55K" as an SDE-only line
 * understated SDE by the $125K market salary.)
 */
export function splitOwnerCompensation(ab: UiAddback): { lines: UiAddback[]; note: string | null } {
  const marketInfo = marketSalaryOf(ab);
  if (marketInfo === null) {
    // No market salary: an "above market" line is the excess (both metrics,
    // but SDE is missing the market part); a full-pay line counts for SDE only.
    if (EXCESS_LABEL_RE.test(ab.label)) {
      return {
        lines: [{ ...ab, type: "ebitda", confidence: "low" }],
        note: `"${ab.label}" is the owner's pay above market, but the market salary isn't stated — SDE should also add back the market salary. Add it to complete SDE.`,
      };
    }
    return {
      lines: [{ ...ab, type: "sde" }],
      note: `"${ab.label}" is added back in full for SDE. Set a market salary for the role to normalise adjusted EBITDA for the owner's pay.`,
    };
  }
  const market = (y: string) => (typeof marketInfo === "number" ? marketInfo : marketInfo[y] ?? Object.values(marketInfo)[0]);
  const actual = actualCompOf(ab, market);
  if (!actual) {
    return {
      lines: [{ ...ab, type: "sde", confidence: "low" }],
      note: `"${ab.label}": state the owner's actual compensation and the market replacement salary separately — SDE adds back the full compensation, EBITDA only the part above market.`,
    };
  }
  const years = Object.keys(actual).sort();
  const latest = years[years.length - 1];
  const excess: UiAddback = {
    ...ab,
    type: "ebitda",
    amounts: Object.fromEntries(years.map((y) => [y, Math.round(actual[y] - market(y))])),
    ownerActualComp: actual,
    marketSalary: marketInfo,
    ownerCompPart: "excess",
    description: `Owner's pay ${fmt(actual[latest])}${years.length > 1 ? ` (${latest})` : ""} less a ${fmt(market(latest))} market salary for the role: the difference counts for EBITDA and SDE; the market salary is added back for SDE only.${ab.description ? ` ${ab.description}` : ""}`,
  };
  // An owner paid below market gets a negative EBITDA adjustment (a buyer
  // pays more for the role); the two lines still sum to the actual pay.
  const marketLine: UiAddback = {
    id: `${ab.id}_market`,
    label: `${ab.label} — market salary`,
    description: "SDE adds back the owner's full pay; this is the market-salary part. A buyer who hires someone for the role pays it, so it is not added back to EBITDA.",
    category: "owner_comp",
    type: "sde",
    amounts: Object.fromEntries(years.map((y) => [y, Math.round(market(y))])),
    approved: ab.approved,
    ...(ab.confidence ? { confidence: ab.confidence } : {}),
    ownerCompPart: "market",
  };
  return { lines: [excess, marketLine], note: null };
}

export function applyAddbackRules(n: UiNormalization | null): UiNormalization | null {
  if (!n) return n;
  const notes: string[] = [...(n.notes ?? [])];
  const input = Array.isArray(n.addbacks) ? n.addbacks : [];
  const addbacks: UiAddback[] = [];
  const retyped: string[] = [];
  for (const ab of input) {
    if (brokerOwned(ab) || ab.ownerCompPart) { addbacks.push(ab); continue; }
    const out: UiAddback = { ...ab, amounts: { ...ab.amounts }, ...(ab.ownerActualComp ? { ownerActualComp: { ...ab.ownerActualComp } } : {}) };
    const description = out.description ?? "";
    // A line that IS a distribution.
    if (isDistributionLine(out)) {
      if (out.approved) {
        out.approved = false;
        out.description = `Not an add-back — dividends and owner draws are distributions of after-tax profit, not P&L expenses.${description ? ` ${description}` : ""}`;
        notes.push(`"${out.label}" is a distribution to the shareholder, not an expense on the P&L, so it is not added back. It is listed for reference only.`);
      }
      addbacks.push(out);
      continue;
    }
    // Owner compensation that folded a dividend in: take the dividend out —
    // but only when the description says it is IN the figure. "The $60,000
    // dividend is excluded" means the model already left it out.
    const clauses = isOwnerComp(out) ? dividendClauses(description) : [];
    const clause = clauses[0];
    if (clause && !clauses.some((c) => EXCLUSION_RE.test(c))) {
      const d = dividendAmount(clause) ?? dividendAmount(description);
      const included = INCLUSION_RE.test(clause) || (d !== null && dividendAddsUp(description, d, out.amounts));
      const years = Object.keys(out.amounts).filter((y) => (out.amounts[y] ?? 0) >= (d ?? Infinity) * 0.98);
      const named = years.filter((y) => description.includes(y));
      const target = named.length > 0 ? named : years.length === 1 ? years : [];
      if (included && d && target.length > 0) {
        for (const y of target) {
          out.amounts[y] = Math.round(out.amounts[y] - d);
          if (out.ownerActualComp && (out.ownerActualComp[y] ?? 0) >= d * 0.98) out.ownerActualComp[y] = Math.round(out.ownerActualComp[y] - d);
        }
        out.description = `${description} — the ${fmt(d)} dividend is excluded (a distribution, not compensation).`;
        notes.push(`Owner compensation add-back "${out.label}" included a ${fmt(d)} dividend; dividends are distributions of after-tax profit and are not added back, so it was removed (${target.join(", ")}).`);
      } else {
        out.confidence = "low";
        notes.push(`"${out.label}" mentions a dividend or draw. Dividends and draws are distributions, not add-backs — check that none is included in the amount.`);
      }
    }
    // A clawback removed as if it were income.
    if (isClawbackLine(out) && Object.values(out.amounts).some((v) => v < 0) && out.approved) {
      out.approved = false;
      out.description = `Not removed as income — a clawback the business repaid is a cost, not income.${description ? ` ${description}` : ""}`;
      notes.push(`"${out.label}" is a clawback the business had to repay (a cost), not income; it is not deducted from earnings again.`);
    }
    // The working owner's pay: the above-market part (EBITDA and SDE) and the
    // market-salary part (SDE only).
    if (isOwnerPayLine(out)) {
      const { lines, note } = splitOwnerCompensation(out);
      if (note) notes.push(note);
      addbacks.push(...lines);
      continue;
    }
    // Everything else — owner perks run through the company, a relative's
    // pay, discretionary and one-time items — counts for adjusted EBITDA as
    // well as SDE. Only the owner's market salary is SDE-only.
    if (out.type === "sde") {
      out.type = "ebitda";
      if (out.approved) retyped.push(out.label);
    }
    addbacks.push(out);
  }
  // SDE adds back ONE working owner's full pay. With several owners' market
  // salaries, the largest stays; the others are a real cost of the business.
  const marketLines = addbacks.filter((a) => a.ownerCompPart === "market" && !brokerOwned(a));
  if (marketLines.length > 1) {
    const total = (a: UiAddback) => Object.values(a.amounts).reduce((s, v) => s + (Number(v) || 0), 0);
    const keep = marketLines.reduce((best, a) => (total(a) > total(best) ? a : best));
    const dropped = marketLines.filter((a) => a !== keep);
    for (const a of dropped) addbacks.splice(addbacks.indexOf(a), 1);
    notes.push(`SDE adds back one working owner's full pay (${keep.label.replace(/ — market salary$/, "")}). The market salary for ${dropped.map((a) => a.label.replace(/ — market salary$/, "")).join(", ")} stays as a cost — a buyer would pay someone for that role.`);
  }
  if (retyped.length > 0) {
    notes.push(`Adjusted EBITDA includes the owner-related and discretionary add-backs too (${retyped.join(", ")}); only the owner's market salary is SDE-only, so SDE = adjusted EBITDA + the market salary.`);
  }
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
      // Someone else's figure ("Seller initially claimed $4.1M adjusted
      // EBITDA", "$4.1M as claimed by the seller") is reported, not stated —
      // never "corrected". Judged on the words up to the figure and right
      // after it, not on a later aside ("= $1,777,000 (rounds to the seller's
      // claimed ~$1.8M)" is still the analysis's own figure).
      const after = sentence.slice(amount.end, amount.end + 40).split(/[(;]|\s[—–]\s/)[0];
      if (ATTRIBUTION_RE.test(sentence.slice(0, amount.end) + after)) continue;
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
