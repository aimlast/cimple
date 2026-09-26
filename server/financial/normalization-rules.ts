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
 *     are out of NWC. Year-end NWC comes from the balance sheet, and the peg
 *     is their average — computed here, never one period's balance and
 *     never with a buffer on top. (Beacon: cash of $871,410 counted in NWC
 *     "excluding cash", and the peg set equal to it. Ridgeline: "trailing
 *     average plus 10% buffer".)
 *  3. EBITDA and SDE are computed in code from their components and stored
 *     as the canonical figures; any insight or note that states a different
 *     amount is flagged with the computed one. (Beacon: EBITDA stated as
 *     $679,312 while its own components sum to $660,252.)
 *
 * Pure — used by the analyzer after each run and by the PATCH route after a
 * broker edit. Broker decisions (custom add-backs, approval overrides) are
 * never undone.
 */
import type { UiAddback, UiInsights, UiInsight, UiNormalization, UiReclassifiedTable, UiWorkingCapital, UiWorkingCapitalItem } from "./shape";
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
/**
 * The clause says the dividend IS in the figure. Not "and": "$180,000
 * salary and $60,000 in dividends" lists two amounts, it doesn't total them.
 */
const STRONG_INCLUSION_RE = /\+|\bplus\b|\binclud(?:es|ing|ed)\b|\bcombined\b|\btotal(?:l?ing)?\b|\bmade\s+up\s+of\b|\bconsist(?:s|ing)\s+of\b/i;

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

/** A discrepancy about the owner's pay ("Owner compensation (2024)", factKey ownerSalary). */
export function isOwnerCompDiscrepancy(field: string | null | undefined, factKey?: string | null): boolean {
  const text = `${field ?? ""} ${(factKey ?? "").replace(/([a-z])([A-Z])/g, "$1 $2")}`;
  return OWNER_WORD_RE.test(text) && /\b(?:comp|compensation|salary|salaries|wages?|pay|remuneration|add-?backs?)\b/i.test(text);
}

// ── Owner pay: reading a stated breakdown ──

/** A money amount, never glued to the next word ("$180,000 management fee" is not $180M). */
const PAY_MONEY_RE = /\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s?(?:k|mm|m|million|thousand)\b)?/gi;
/** Where one term of a breakdown ends: "+", ";", "(", ")", "=", "plus", "and", "totalling", " — ". A comma inside a number isn't one. */
const TERM_SEP_RE = /\s*(?:\+|;|,(?=\s)|\(|\)|=|\bplus\b|\band\b|\balong\s+with\b|\binclud(?:es|ing|ed)\b|\bof\s+which\b|\btotall?ing\b|\bfor\s+a\s+total\s+of\b|\s[—–]\s|\s-\s)\s*/gi;
const TOTAL_SEP_RE = /^\s*(?:=|totall?ing|for\s+a\s+total\s+of)\s*$/i;
const TOTAL_WORD_RE = /\b(?:total|in\s+all|combined|altogether|all[- ]in)\b/i;
const PAY_KIND_RE = /\b(?:salary|salaries|wages?|t4|payroll|bonus(?:es)?|benefits?|compensation|comp|remuneration|management\s+fees?|pension|rrsp|allowance|pay)\b/i;
const OTHER_KIND_RE =
  /\b(?:personal|perks?|vehicle|truck|car|auto|fuel|meals?|travel|cell|phone|tickets?|club|family|spouse|wife|husband|son|daughter|relatives?|expenses?|costs?|run\s+through)\b/i;

type PayTermKind = "pay" | "distribution" | "other" | "unknown";
interface PayTerm {
  value: number;
  /** The term as written ("T4 salary $180,000"). */
  text: string;
  kind: PayTermKind;
  totalHint: boolean;
  /** The text says this amount is NOT in the figure ("dividends of $60,000 paid separately"). */
  excludedInText: boolean;
}

function termKind(label: string): PayTermKind {
  if (DIVIDEND_MENTION_RE.test(label) || /\bdraws?\b|\bdistributions?\b/i.test(label)) return "distribution";
  // "personal expenses", "Donna's wage" are not the owner's pay even with a pay word.
  if (/\b(?:personal|perks?|family|spouse|wife|husband|son|daughter|relatives?)\b/i.test(label)) return "other";
  if (PAY_KIND_RE.test(label)) return "pay";
  if (OTHER_KIND_RE.test(label)) return "other";
  return "unknown";
}

/**
 * The terms of a stated owner-pay figure: every amount with the words of
 * its own term, what kind of money it is, and which amount (if any) is the
 * total of the others. "$268,000 total (T4 salary $180,000 + T5 dividends
 * $60,000 + personal expenses $28,000)" → total $268,000 = pay $180,000 +
 * distribution $60,000 + other $28,000. "$180,000 T4 salary and $60,000 in
 * dividends" has no total: the salary is not a figure that includes the
 * dividend (the round-1 reader took the first amount as a total and made
 * $120,000 of it).
 */
export function ownerPayBreakdown(text: string): { total: PayTerm | null; parts: PayTerm[] } | null {
  const seps = Array.from(text.matchAll(TERM_SEP_RE)).map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));
  const terms: PayTerm[] = [];
  const amounts = Array.from(text.matchAll(PAY_MONEY_RE));
  amounts.forEach((m, i) => {
    const s = m.index!;
    const e = s + m[0].length;
    const value = moneyValue(m[0]);
    if (value === null) return;
    const before = seps.filter((x) => x.end <= s).pop();
    const after = seps.find((x) => x.start >= e);
    // A term holds one amount: two in one stretch of words split between them.
    const prevEnd = i > 0 ? amounts[i - 1].index! + amounts[i - 1][0].length : 0;
    const nextStart = i < amounts.length - 1 ? amounts[i + 1].index! : text.length;
    const segStart = Math.max(before ? before.end : 0, prevEnd);
    const segEnd = Math.min(after ? after.start : text.length, nextStart);
    const termText = text.slice(segStart, segEnd).replace(/\s+/g, " ").trim();
    const label = `${text.slice(segStart, s)} ${text.slice(e, segEnd)}`;
    terms.push({
      value,
      text: termText,
      kind: termKind(label),
      totalHint: TOTAL_WORD_RE.test(label) || (!!before && TOTAL_SEP_RE.test(before.text)),
      excludedInText: EXCLUSION_RE.test(label),
    });
  });
  if (terms.length === 0) return null;
  // The total: the amount the others add up to, else one the text calls a total.
  let total: PayTerm | null = null;
  if (terms.length >= 3) {
    total = terms.find((t) => within(t.value, terms.filter((x) => x !== t).reduce((s, x) => s + x.value, 0))) ?? null;
  }
  if (!total) {
    const hinted = terms.filter((t) => t.totalHint);
    if (hinted.length > 0) total = hinted.reduce((a, b) => (b.value > a.value ? b : a));
  }
  return { total, parts: terms.filter((t) => t !== total) };
}

const PAY_ONLY_MARK_RE = /\bthe owner's pay only\b|excludes the \$[\d,]+ dividend/i;

/**
 * One side of an owner-compensation discrepancy restated as the owner's pay
 * only — the dividend rule (and "one add-back is not owner pay") applied to
 * the conflict the broker reads, not only to the add-backs. "$268,000 total
 * (T4 salary $180,000 + T5 dividends $60,000 + personal expenses through
 * company $28,000)" becomes "$180,000 — the owner's pay only (T4 salary
 * $180,000); not counted: T5 dividends $60,000 (a distribution, not pay),
 * personal expenses through company $28,000 (a separate add-back, not
 * pay)". A trailing " — source" label is kept. Null when the value lists no
 * dividend or other non-pay amount (a bare "$260,000 total owner
 * compensation" is left as stated), when the text already says the
 * dividend is left out, or when it is already restated.
 */
export function ownerPayOnly(value: string | null | undefined): string | null {
  if (!value || PAY_ONLY_MARK_RE.test(value)) return null;
  // A " — source" label after the figure stays as it is — unless the breakdown is in it.
  const cut = value.lastIndexOf(" — ");
  const tail = cut > 0 ? value.slice(cut + 3) : "";
  const tailHasMoney = /\$\s?\d/.test(tail);
  const main = cut > 0 && !tailHasMoney ? value.slice(0, cut) : value;
  const label = cut > 0 && !tailHasMoney ? value.slice(cut) : "";
  const bd = ownerPayBreakdown(main);
  if (!bd) return null;
  const { total, parts } = bd;
  // A dividend the text itself keeps out ("paid separately") isn't in the figure.
  if (parts.some((p) => p.kind === "distribution" && p.excludedInText)) return null;
  const excluded = parts.filter((p) => p.kind === "distribution" || p.kind === "other");
  if (excluded.length === 0) return null;
  const kept = parts.filter((p) => p.kind === "pay" || p.kind === "unknown");
  const pay = kept.length > 0 ? kept.reduce((s, p) => s + p.value, 0) : total ? total.value - excluded.reduce((s, p) => s + p.value, 0) : 0;
  if (!(pay > 0)) return null;
  const why = (p: PayTerm) => (p.kind === "distribution" ? "a distribution, not pay" : "a separate add-back, not pay");
  return `${fmt(pay)} — the owner's pay only${kept.length > 0 ? ` (${kept.map((p) => p.text).join(" + ")})` : ""}; not counted: ${excluded.map((p) => `${p.text} (${why(p)})`).join(", ")}${label}`;
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
      // The stated breakdown decides whether the amount includes the
      // dividend: the amount equals the figure WITH it ("salary $180K +
      // $60K dividend + $28K benefits" = $268K), or the figure without it
      // ("$180,000 T4 salary and $60,000 in dividends" on a $180K line: the
      // dividend was never in it — nothing to take out).
      const bd = ownerPayBreakdown(description);
      const divParts = bd?.parts.filter((p) => p.kind === "distribution") ?? [];
      let d: number | null;
      let included: boolean;
      let years: string[];
      let alreadyOut = false;
      if (bd && divParts.length > 0 && bd.parts.length + (bd.total ? 1 : 0) >= 2) {
        d = divParts.reduce((s, p) => s + p.value, 0);
        const withDividend = bd.total ? bd.total.value : bd.parts.reduce((s, p) => s + p.value, 0);
        years = Object.keys(out.amounts).filter((y) => within(out.amounts[y] ?? 0, withDividend));
        alreadyOut = years.length === 0 && Object.values(out.amounts).some((v) => within(Number(v) || 0, withDividend - d!));
        included = years.length > 0;
      } else {
        d = dividendAmount(clause) ?? dividendAmount(description);
        included = STRONG_INCLUSION_RE.test(clause) || (d !== null && dividendAddsUp(description, d, out.amounts));
        years = Object.keys(out.amounts).filter((y) => (out.amounts[y] ?? 0) >= (d ?? Infinity) * 0.98);
      }
      const named = years.filter((y) => description.includes(y));
      const target = named.length > 0 ? named : years.length === 1 ? years : [];
      if (alreadyOut) {
        // The amount is the pay without the dividend — nothing to do.
      } else if (included && d && target.length > 0) {
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

const isExcludedAsset = (name: string) => (CASH_RE.test(name) && !/receivable/i.test(name)) || EXCLUDED_ASSET_RE.test(name);
const isExcludedLiability = (name: string) => DEBT_RE.test(name);
const yearOf = (period: string | null | undefined) => String(period ?? "").match(/(?:19|20)\d{2}/g)?.pop() ?? null;

/**
 * A balance-sheet section's rows for one year, signed the way the section
 * reads: assets and liabilities are positive, and a contra or opposite
 * balance keeps its minus sign (an allowance for doubtful accounts reduces
 * current assets; a net HST receivable or a debit gift-card balance filed
 * under current liabilities reduces them). Summed with their signs, as the
 * balance-sheet table and the working-capital panel sum them. A section the
 * model wrote with negative liabilities throughout (the opposite
 * convention) is turned round as a whole, so its contra rows still count
 * against it — never Math.abs row by row, which made a −$57,167 gift-card
 * balance a $57,167 liability.
 */
function signedSectionRows(
  bs: UiReclassifiedTable,
  category: string,
  year: string,
  excluded: (name: string) => boolean,
): Array<{ name: string; amount: number }> {
  const rows = bs.rows.filter((r) => r.category === category && Number.isFinite(r.values?.[year]) && !excluded(r.name));
  const net = rows.reduce((s, r) => s + r.values[year], 0);
  const flip = net < 0 && rows.filter((r) => r.values[year] < 0).length > rows.length / 2 ? -1 : 1;
  return rows.map((r) => ({ name: r.name, amount: flip * r.values[year] }));
}

/**
 * Year-end net working capital for every year the balance sheet has both
 * current assets and current liabilities — cash-free and debt-free, by the
 * same exclusions as the working-capital panel. Keyed by the table's year.
 */
export function workingCapitalHistory(bs: UiReclassifiedTable | null | undefined): Record<string, number> {
  if (!bs || !Array.isArray(bs.rows)) return {};
  const years = bs.years?.length ? bs.years : Array.from(new Set(bs.rows.flatMap((r) => Object.keys(r.values ?? {}))));
  const out: Record<string, number> = {};
  for (const y of years) {
    const has = (category: string) => bs.rows.some((r) => r.category === category && Number.isFinite(r.values?.[y]));
    if (!has("Current Assets") || !has("Current Liabilities")) continue;
    const total = (category: string, excluded: (name: string) => boolean) =>
      signedSectionRows(bs, category, y, excluded).reduce((s, r) => s + r.amount, 0);
    out[y] = Math.round(total("Current Assets", isExcludedAsset) - total("Current Liabilities", isExcludedLiability));
  }
  return out;
}

/** A note about working capital that states a year-end figure the balance sheet doesn't give. */
function contradictsHistory(note: string, history: Record<string, number>): boolean {
  if (!/\b(?:nwc|net\s+working\s+capital|working\s+capital)\b/i.test(note)) return false;
  const byYear = new Map(Object.entries(history).map(([k, v]) => [yearOf(k) ?? k, v]));
  const noteYears = Array.from(new Set(Array.from(note.matchAll(/\b(?:FY\s?)?((?:19|20)\d{2})\b/gi)).map((m) => m[1]))).filter((y) => byYear.has(y));
  const money = new RegExp(String.raw`\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?\b`, "gi");
  for (const m of Array.from(note.matchAll(money))) {
    const value = moneyValue(m[0]);
    if (value === null || value < 1000) continue;
    const start = m.index!;
    const end = start + m[0].length;
    // The year the text ties this figure to: "$1,099,630 (2022)", "$X in 2023",
    // "2024: $X", or the result of "… = $X" in a note about one year. A
    // component ("$505K AR + …") has none of these and is never judged.
    const after = note.slice(end, end + 20).match(/^\s*(?:\(\s*(?:FY\s?)?((?:19|20)\d{2})\s*\)|(?:in|for|at)\s+(?:FY\s?|fiscal\s+)?((?:19|20)\d{2})\b)/i);
    const before = note.slice(Math.max(0, start - 14), start).match(/\b((?:19|20)\d{2})\s*[:–-]\s*$/);
    const result = /=\s*$/.test(note.slice(Math.max(0, start - 4), start)) && noteYears.length === 1 ? noteYears[0] : null;
    const year = after?.[1] ?? after?.[2] ?? before?.[1] ?? result;
    const h = year ? byYear.get(year) : undefined;
    if (h === undefined || h === 0) continue;
    // A note that IS a statement of net working capital ("NWC at December 31,
    // 2024 = … = $1,555,130") is judged on its result whatever its size (that
    // one counted the cash); elsewhere only an NWC-sized figure is.
    const aboutNwc = result !== null && /^\s*(?:net\s+working\s+capital|nwc)\b/i.test(note);
    const nwcSized = aboutNwc || Math.abs(value - h) / Math.abs(h) <= 0.15;
    if (nwcSized && Math.abs(value - h) > Math.max(1000, Math.abs(h) * 0.005)) return true;
  }
  return false;
}

/** Model notes about a peg or target — the peg is set in code, so these would contradict it. */
const PEG_NOTE_RE = /\bpeg\b|\btarget\s+(?:nwc|net\s+working\s+capital|working\s+capital)\b/i;

/**
 * Working capital is cash-free and debt-free, its figures come from the
 * balance sheet, and the peg is worked out in code: the average of the
 * year-end net working capital of every balance sheet on file — never one
 * period's balance, never a figure with a buffer added. (Ridgeline: a peg
 * of "trailing average plus 10% buffer" that matched neither; historical
 * NWC stated as $1,099,630 against $1,072,000 on the statements. Lakeshore:
 * a $300,000 peg next to a $301,000 closing balance.)
 */
export function applyWorkingCapitalRules(
  wc: UiWorkingCapital | null,
  balanceSheet?: UiReclassifiedTable | null,
): UiWorkingCapital | null {
  if (!wc) return wc;
  const sum = (xs: UiWorkingCapitalItem[]) => xs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const originalNwc = Number.isFinite(wc.netWorkingCapital) ? wc.netWorkingCapital : sum(wc.currentAssets) - sum(wc.currentLiabilities);
  const removed: UiWorkingCapitalItem[] = [];
  // "Accounts receivable" etc. never match; a row named for cash or a
  // shareholder balance does.
  let currentAssets = wc.currentAssets.filter((i) => {
    const out = isExcludedAsset(i.name);
    if (out) removed.push(i);
    return !out;
  });
  let currentLiabilities = wc.currentLiabilities.filter((i) => {
    const out = isExcludedLiability(i.name);
    if (out) removed.push(i);
    return !out;
  });
  const history = workingCapitalHistory(balanceSheet);
  const historyYears = Object.keys(history).sort((a, b) => (yearOf(a) ?? a).localeCompare(yearOf(b) ?? b));
  // With a balance sheet the peg and the year-end figures are the code's;
  // the model's own peg notes and any year-end figure it misstated go.
  const incoming = wc.notes ?? [];
  const notes = historyYears.length > 0
    ? incoming.filter((n) => !PEG_NOTE_RE.test(n) && !contradictsHistory(n, history))
    : [...incoming];
  let netWorkingCapital = wc.netWorkingCapital;
  if (removed.length > 0) {
    netWorkingCapital = sum(currentAssets) - sum(currentLiabilities);
    notes.push(
      `Net working capital is on a cash-free, debt-free basis: cash, bank debt, the current portion of long-term debt, shareholder loans and income taxes are excluded. Removed: ${removed.map((i) => `${i.name} (${fmt(i.amount)})`).join(", ")}.`,
    );
  }

  // The closing period ties to the balance sheet: if the listed items don't
  // add up to that year's balance-sheet figure, list the balance sheet's own.
  const asOfKey = historyYears.find((k) => yearOf(k) === yearOf(wc.asOfPeriod)) ?? (wc.asOfPeriod ? undefined : historyYears[historyYears.length - 1]);
  if (asOfKey && balanceSheet && Math.abs(netWorkingCapital - history[asOfKey]) > Math.max(1, Math.abs(history[asOfKey]) * 0.001)) {
    currentAssets = signedSectionRows(balanceSheet, "Current Assets", asOfKey, isExcludedAsset);
    currentLiabilities = signedSectionRows(balanceSheet, "Current Liabilities", asOfKey, isExcludedLiability);
    netWorkingCapital = history[asOfKey];
    notes.push(`The ${yearOf(asOfKey) ?? asOfKey} working capital lines are taken from the balance sheet (net working capital ${fmt(netWorkingCapital)}).`);
  }

  let pegAmount = wc.pegAmount ?? null;
  let targetNwc = wc.targetNwc ?? null;
  let pegBasis: string | undefined;
  if (historyYears.length >= 2) {
    const avg = Math.round(historyYears.reduce((s, k) => s + history[k], 0) / historyYears.length);
    pegAmount = avg;
    targetNwc = avg;
    const first = yearOf(historyYears[0]) ?? historyYears[0];
    const last = yearOf(historyYears[historyYears.length - 1]) ?? historyYears[historyYears.length - 1];
    pegBasis = `Average of year-end net working capital, ${first}–${last} (${historyYears.length} balance sheets)`;
    notes.push(
      `Suggested peg ${fmt(avg)}: the average of year-end net working capital (${historyYears.map((k) => `${yearOf(k) ?? k} ${fmt(history[k])}`).join(", ")}), on the same cash-free, debt-free basis. Monthly balance sheets would allow a trailing-twelve-month average; any allowance for growth or seasonality is yours to negotiate.`,
    );
  } else if (historyYears.length === 1) {
    pegAmount = null;
    targetNwc = null;
    notes.push(`No peg is suggested yet: only the ${yearOf(historyYears[0]) ?? historyYears[0]} year-end balance sheet is on file, and a peg is an average over several periods. Add earlier balance sheets or monthly balances to set one.`);
  } else {
    // No balance sheet to average: a peg equal to one period's NWC, or one
    // with a buffer on top, isn't a peg.
    const isSinglePeriod = (v: number | null | undefined) =>
      typeof v === "number" && [originalNwc, netWorkingCapital].some((n) => Math.abs(v - n) <= Math.max(1, Math.abs(n) * 0.005));
    const buffered = incoming.some((n) => /\bpeg\b|\btarget\b/i.test(n) && /\bbuffer\b|\bcushion\b|\bplus\s+\d+(?:\.\d+)?\s*%/i.test(n));
    if (buffered || isSinglePeriod(pegAmount) || isSinglePeriod(targetNwc)) {
      if (pegAmount !== null || targetNwc !== null) {
        notes.push("A working-capital peg is the average net working capital over several periods, with nothing added on top — one period's balance isn't a peg. Set it once earlier balance sheets or monthly balances are on file.");
      }
      pegAmount = null;
      targetNwc = null;
    }
    // The peg IS the target NWC; a different "peg" is usually the closing
    // adjustment (actual minus target) put in the wrong place.
    if (targetNwc !== null && pegAmount !== null && Math.abs(pegAmount - targetNwc) > Math.max(1, Math.abs(targetNwc) * 0.01)) {
      notes.push(`The peg is the target net working capital, ${fmt(targetNwc)}. Any difference between the closing balance and the target is settled as the closing adjustment.`);
      pegAmount = targetNwc;
    }
  }
  return {
    ...wc,
    currentAssets,
    currentLiabilities,
    netWorkingCapital,
    pegAmount,
    targetNwc,
    ...(historyYears.length > 0 ? { history: Object.fromEntries(historyYears.map((k) => [k, history[k]])) } : {}),
    ...(pegBasis ? { pegBasis } : {}),
    notes: Array.from(new Set(notes)),
  };
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
  /** How the text names it: "SDE", "adjusted EBITDA", "reported EBITDA", "EBITDA". */
  label: string;
  year: string;
  stated: number;
  expected: number;
}

const METRIC_RE = /\b(adjusted\s+|normali[sz]ed\s+|reported\s+|unadjusted\s+)?(ebitda|sde)\b/gi;

const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:k|mm|m|million|thousand)?\b|\b\d[\d,]*(?:\.\d+)?\s*(?:k|mm|m|million|thousand)\b/gi;
const YEAR_RE_G = /\b(?:FY\s?)?((?:19|20)\d{2})\b/gi;
const ATTRIBUTION_RE = /\b(?:claim(?:s|ed)?|stated?|states|says|said|quoted|expects?|estimated by|per (?:the )?(?:seller|broker|buyer|owner|accountant|cpa)|seller'?s|owner'?s|buyer'?s|broker'?s|initially|originally|previously|earlier)\b/i;
/**
 * The only words that may sit between a metric and its figure ("adjusted
 * EBITDA for FY2024 of $1,552,000", "SDE grew 33% from 2022 to 2024, reaching
 * $1.31M"). Anything else — "includes", "above", "adds back" — means the
 * figure is about something else ("EBITDA includes the $100K above market").
 */
const LINK_WORDS = new Set([
  "of", "is", "was", "were", "at", "to", "for", "in", "the", "a", "an", "year", "years", "fiscal", "ended", "fy",
  "reached", "reaching", "reaches", "total", "totals", "totaled", "totalled", "totaling", "totalling", "came", "comes",
  "stood", "stands", "sits", "grew", "grows", "rose", "rises", "increased", "increasing", "decreased", "declined", "fell",
  "from", "approximately", "approx", "about", "roughly", "around", "nearly", "equals", "equal", "would", "be", "been",
  "will", "into", "now", "then", "further", "normalized", "normalised", "adjusted", "reported", "and",
]);
/** Right after the figure: it is a difference or a part, not the metric itself. */
const AFTER_BREAK_RE = /^\s*(?:excess|above|over|more|less|higher|lower|below|increase|decrease|improvement|decline|drop|gap|difference|shortfall|of\s+add-?backs?|in\s+add-?backs?|add-?backs?|adjustments?|per\s+(?:month|week)|a\s+(?:month|week))\b/i;
/**
 * Followed by an operator and another amount: the figure is a term of a sum —
 * right after it ("$563,190 + …") or after its own label ("$896,410 net
 * income + …"). A label never names a metric: "$1,552,000 and SDE − …" is
 * not a term.
 */
const TERM_RE = /^\s*(?:\([^)]*\)\s*)?(?:[+=×*/]|[-−–]\s*[$(\d])/;
const LABELLED_TERM_RE = /^\s*(?:\([^)]*\)\s*)?(?:(?!(?:adjusted|normali[sz]ed|reported|ebitda|sde|and|or|was|is|in|for)\b)[A-Za-z&'’.-]+\s+){1,5}(?:[+×*/]|[-−–]\s*[$(\d])/i;
const isTerm = (rest: string) => TERM_RE.test(rest) || LABELLED_TERM_RE.test(rest);
/** A sentence that heads a worked calculation: "SDE calculation: …", "Adjusted EBITDA by year:". */
const CALC_HEADER_RE = /\b(adjusted\s+|normali[sz]ed\s+|reported\s+|unadjusted\s+)?(ebitda|sde)\s*(?:\([^)]{0,20}\)\s*)?(?:calculation|computation|build[- ]?up|bridge|reconciliation|breakdown|by\s+year|walk)?\s*:/i;
/** A sentence that opens with its year: "2022: $386,174 + … = $969,000." */
const YEAR_LED_RE = /^\s*\(?(?:FY\s?)?(?:19|20)\d{2}\)?\s*[:–—-]/i;
const APPROX_RE = /(?:~|≈|\babout|\bapprox\.?|\bapproximately|\baround|\broughly|\bnearly|\bclose to)\s*$/i;

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

function yearsIn(text: string): string[] {
  return Array.from(text.matchAll(YEAR_RE_G)).map((m) => m[1]);
}

/**
 * How far a stated figure may be from the computed one: the rounding its
 * own writing implies ("$1.31M" → ±$5,000; "$1,313,000" → ±$500), with a
 * 0.1% floor for the components' own rounding — and 2% when hedged
 * ("approximately $1.3M"). A flat 1% hid real misstatements: "$1,313,000"
 * against a computed $1,303,000 is a different figure, not a rounding.
 */
function allowedDifference(raw: string, computed: number, hedged: boolean): number {
  const m = raw.replace(/\$/g, "").trim().match(/^(\d[\d,]*)(?:\.(\d+))?\s*(k|mm|m|million|thousand)?/i);
  let unit = 1;
  if (m) {
    const suffix = (m[3] || "").toLowerCase();
    const mult = suffix === "k" || suffix === "thousand" ? 1e3 : suffix ? 1e6 : 1;
    if (m[2]) unit = mult * Math.pow(10, -m[2].length);
    else if (suffix) unit = mult;
    else {
      const trailingZeros = m[1].replace(/,/g, "").match(/0*$/)?.[0].length ?? 0;
      unit = Math.pow(10, Math.min(trailingZeros, 3));
    }
  }
  const base = Math.max(unit / 2, Math.abs(computed) * 0.001, 1);
  return hedged ? Math.max(base, Math.abs(computed) * 0.02) : base;
}

interface StatedFigure {
  metric: "EBITDA" | "SDE";
  qualifier: string;
  amount: MoneyAt;
  hedged: boolean;
  /** The fiscal year the text ties the figure to, when it does. */
  year: string | null;
  /** Where attribution is judged ("as claimed by the seller"): the words up to and just after the figure. */
  attributionText: string;
}

function metricOf(m: RegExpMatchArray): { metric: "EBITDA" | "SDE"; qualifier: string } {
  return { metric: m[2].toUpperCase() as "EBITDA" | "SDE", qualifier: (m[1] || "").trim().toLowerCase() };
}

/**
 * Every EBITDA/SDE figure a sentence states, with its year. `carried` is the
 * metric a previous sentence's worked calculation was about, for a sentence
 * that continues it ("SDE calculation: Net income + all add-backs. 2022: …
 * = $969,000. 2023: … = $1,157,000."). Returns the metric the next sentence
 * may carry on with.
 */
function statedFigures(sentence: string, carried: RegExpMatchArray | null = null): { figures: StatedFigure[]; carry: RegExpMatchArray | null } {
  const out: StatedFigure[] = [];
  const monies = moneyIn(sentence);
  const metrics = Array.from(sentence.matchAll(METRIC_RE));
  const sentenceYears = Array.from(new Set(yearsIn(sentence)));
  const onlyYear = sentenceYears.length === 1 ? sentenceYears[0] : null;
  const used = new Set<number>();
  const after = (a: MoneyAt) => sentence.slice(a.end, a.end + 40).split(/[(;]|\s[—–]\s/)[0];
  const trailingYear = (a: MoneyAt) =>
    sentence.slice(a.end, a.end + 18).match(/^\s*(?:\(\s*(?:FY\s?)?((?:19|20)\d{2})\s*\)|(?:in|for|during)\s+(?:FY\s?|fiscal\s+)?((?:19|20)\d{2})\b)/i);

  // 1. Worked sums: "2024 SDE: $563,190 + $749,810 = $1,313,000". A chain's
  //    subject is the metric just before its first "=" (inherited by the next
  //    clause of a list: "…; 2023: … = $…"); its result is the figure right
  //    after an "=" outside parentheses; its year is the clause's own.
  const eqs = Array.from(sentence.matchAll(/=|≈/g)).map((m) => m.index!);
  let chainStart = 0;
  let subject: RegExpMatchArray | null = null;
  let ownSubject = false;
  // Only a sentence that opens with its year continues the previous one's
  // calculation ("2022: … = $969,000."); anything else starts afresh.
  let inherited: RegExpMatchArray | null = carried && YEAR_LED_RE.test(sentence) ? carried : null;
  let lastSubject: RegExpMatchArray | null = null;
  for (const p of eqs) {
    if (p < chainStart) continue;
    const before = sentence.slice(chainStart, p);
    const depth = (before.match(/\(/g) ?? []).length - (before.match(/\)/g) ?? []).length;
    if (depth > 0) continue; // a sub-calculation inside parentheses
    if (!subject) {
      const own = [...metrics].reverse().find((m) => m.index! >= chainStart && m.index! < p) ?? null;
      subject = own ?? inherited;
      ownSubject = !!own;
    }
    const result = monies.find((x) => x.index > p);
    const between = result ? sentence.slice(p + 1, result.index) : "";
    if (!result || !/^\s*(?:approximately|approx\.?|about|~)?\s*$/i.test(between)) continue; // "SDE = adjusted EBITDA + …": a definition
    if (isTerm(sentence.slice(result.end))) continue; // "SDE = $896,410 net income + …": the first term, the result comes later
    // A weighting ("2024 SDE $208,032 × 30% + 2025 SDE $216,018 × 70% =
    // $213,622 weighted average") gives no year's figure as its result; its
    // labelled terms are the statements, read below.
    const weighted = /[×*]|\bx\s*\d/.test(sentence.slice(chainStart, p)) || /^\s*(?:weighted|average|blended|multiple)\b/i.test(sentence.slice(result.end));
    // Every other chain's amounts before its result are terms, never a
    // statement of the metric ("SDE 2024: $896,410 net income + … = …").
    const termsFrom = subject && ownSubject ? subject.index! : chainStart;
    if (!weighted) for (const x of monies) if (x.index >= termsFrom && x.index < result.index) used.add(x.index);
    if (subject && !weighted) {
      lastSubject = subject;
      const clauseYears = yearsIn(sentence.slice(chainStart, p));
      out.push({
        ...metricOf(subject),
        amount: result,
        hedged: sentence[p] === "≈" || /\S/.test(between),
        year: clauseYears.length > 0 ? clauseYears[clauseYears.length - 1] : onlyYear,
        attributionText: sentence.slice(0, result.end) + after(result),
      });
    }
    used.add(result.index);
    inherited = subject;
    subject = null;
    chainStart = result.end;
  }

  // 2. Plain statements: "<metric> [for FY2024] [of/was/reached …] $X",
  //    "<metric> grew from $A (2022) to $B (2024)", "$X of adjusted EBITDA".
  for (const m of metrics) {
    const { metric, qualifier } = metricOf(m);
    const metricEnd = m.index! + m[0].length;
    const push = (amount: MoneyAt, contextYears: string[], hedged: boolean) => {
      if (used.has(amount.index) || AFTER_BREAK_RE.test(sentence.slice(amount.end))) return;
      // A term of a sum ("SDE: $563,190 + $130K + … = …"), not the figure.
      // A weight on it ("2024 SDE $208,032 × 30%") still leaves it the year's figure.
      const rest = sentence.slice(amount.end);
      if (isTerm(rest) && !/^\s*(?:[×*]|x\s*\d)/.test(rest)) return;
      used.add(amount.index);
      const ty = trailingYear(amount);
      // "2024 SDE $208,032": the year written just before the metric.
      const leading = sentence.slice(Math.max(0, m.index! - 12), m.index!).match(/\b(?:FY\s?)?((?:19|20)\d{2})\s*$/i)?.[1];
      out.push({
        metric, qualifier, amount, hedged,
        year: ty ? ty[1] ?? ty[2] : contextYears.length > 0 ? contextYears[contextYears.length - 1] : leading ?? onlyYear,
        attributionText: sentence.slice(0, amount.end) + after(amount),
      });
    };
    const next = monies.find((x) => x.index >= metricEnd);
    if (next && !used.has(next.index)) {
      const gap = sentence.slice(metricEnd, next.index);
      const words = gap.toLowerCase().split(/[^a-z0-9.%]+/).filter(Boolean);
      const linkOnly = gap.length <= 70 && !/[=+×*/]/.test(gap) &&
        words.every((w) => LINK_WORDS.has(w) || /^(?:fy)?(?:19|20)\d{2}$/.test(w) || /^\d+(?:\.\d+)?%$/.test(w));
      if (linkOnly) {
        push(next, yearsIn(gap), APPROX_RE.test(gap));
        // "… from $A (2022) to $B (2024)"
        const rest = sentence.slice(next.end);
        const to = rest.match(/^\s*(?:\(\s*(?:FY\s?)?(?:19|20)\d{2}\s*\)|in\s+(?:FY\s?)?(?:19|20)\d{2})?\s*,?\s*to\s+(?:~|about\s+|approximately\s+)?/i);
        const second = to ? monies.find((x) => x.index === next.end + to[0].length) : undefined;
        if (to && second) push(second, [], /~|about|approximately/i.test(to[0]));
        continue;
      }
    }
    const prev = [...monies].reverse().find((x) => x.end <= m.index!);
    if (prev && /^\s*(?:in\s+|of\s+)?$/i.test(sentence.slice(prev.end, m.index!))) {
      const lead = sentence.slice(Math.max(0, prev.index - 16), prev.index);
      push(prev, yearsIn(lead), APPROX_RE.test(lead));
    }
  }
  // What the next sentence may continue: this one's calculation, or a
  // heading that announces one ("SDE calculation: Net income + all add-backs").
  const header = out.length === 0 ? sentence.match(CALC_HEADER_RE) : null;
  return { figures: out, carry: lastSubject ?? header ?? (out.length === 0 ? inherited : null) };
}

/**
 * EBITDA/SDE amounts stated in text that don't match the computed figures.
 * Conservative about WHAT is read — a false "doesn't tie" erodes trust — but
 * strict about a figure once it is read (its written precision, not a flat
 * 1%):
 *  - worked sums: every "= $X" result of a chain whose subject is the metric
 *    ("SDE calculation: 2022: … = $969,000; 2023: … = …");
 *  - "<metric> [for FY2024] [is/of/was/reached …] $X" with only link words
 *    between them, and "… from $A to $B";
 *  - "$X EBITDA" / "$X in SDE".
 * Someone else's figure ("Seller initially claimed $4.1M") is never judged.
 */
export function findEarningsMismatches(text: string, computed: CanonicalEarnings): Array<Omit<EarningsMismatch, "where">> {
  const out: Array<Omit<EarningsMismatch, "where">> = [];
  const years = Object.keys(computed.adjustedEbitda);
  // The text says "2025" or "FY2025"; the analysis may key its years either way.
  const keyFor = (y: string) => years.find((k) => k === y) ?? years.find((k) => (k.match(/(?:19|20)\d{2}/g)?.pop() ?? k) === y) ?? null;
  let carried: RegExpMatchArray | null = null;
  for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z0-9$(])/)) {
    const { figures, carry } = statedFigures(sentence, carried);
    carried = carry;
    for (const stated of figures) {
      const f = { ...stated, year: stated.year ? keyFor(stated.year) ?? `?${stated.year}` : null };
      if (ATTRIBUTION_RE.test(f.attributionText)) continue;
      const { metric, qualifier } = f;
      const adjusted = qualifier.startsWith("adjusted") || qualifier.startsWith("normali");
      const candidatesFor = (y: string) =>
        metric === "SDE" ? [computed.sde[y]]
        : adjusted ? [computed.adjustedEbitda[y]]
        : qualifier ? [computed.reportedEbitda[y]]
        : [computed.reportedEbitda[y], computed.adjustedEbitda[y]];
      if (f.year && !years.includes(f.year)) continue; // a year the analysis doesn't cover (a forecast, FY2025 YTD)
      const checkYears = f.year ? [f.year] : years;
      const value = f.amount.value;
      const matches = checkYears.some((y) =>
        candidatesFor(y).some((c) => typeof c === "number" && Math.abs(c - value) <= allowedDifference(f.amount.raw, c, f.hedged)),
      );
      if (matches) continue;
      // Without a year, only flag when the figure matches no year at all.
      const y = f.year ?? computed.latestYear!;
      const expected = candidatesFor(y)[0];
      if (typeof expected !== "number") continue;
      const label = metric === "SDE" ? "SDE" : adjusted ? "adjusted EBITDA" : qualifier ? "reported EBITDA" : "EBITDA";
      out.push({ metric, label, year: y, stated: value, expected });
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
      const check = found.map((f) => `the normalization computes ${f.year} ${f.label} as ${fmt(f.expected)}, not ${fmt(f.stated)}`).join("; ");
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
      notes.push(`Check: the note above states ${f.year} ${f.label} as ${fmt(f.stated)}; the add-backs listed here compute ${fmt(f.expected)}.`);
    }
  }
  return { ...normalization, notes: Array.from(new Set(notes)) };
}
