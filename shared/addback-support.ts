/**
 * How far the transactions linked to an add-back support its claimed amount
 * — worked out in code from the transactions themselves, never taken from
 * the model's own total. Used by the server (after matching) and the add-back
 * screen (after the broker links transactions by hand), so both say the same.
 *
 *  matched        the linked transactions add up to within 15% of the claim
 *  partial_match  some support exists, but less than the claim
 *                 (a $60,000 vehicle add-back with $12,000 of vehicle charges)
 *  exceeds_claim  the linked transactions add up to MORE than the claim: the
 *                 add-back is a portion of what was paid (the above-market
 *                 part of $60,000 of related-party rent) — the payments are
 *                 there, the portion is a judgment to confirm
 *  no_match       nothing linked
 *
 * The claim is compared over the period the ledger covers: three months of
 * bank statements hold a quarter of a year's rent, fifteen months of GL hold
 * a year and a quarter of a salary.
 */

/** A claim is "matched" when the supporting transactions are within this share of it. */
export const ADDBACK_MATCH_TOLERANCE = 0.15;

export type AddbackSupportStatus = "matched" | "partial_match" | "exceeds_claim" | "no_match";

export interface SupportTransaction {
  amount: number;
  date?: string | null;
}

export interface SupportClaim {
  annualAmount: number;
  yearAmounts?: Record<string, number> | null;
  /** One-time / non-recurring add-backs are one amount, never pro-rated to a period. */
  category?: string | null;
}

export interface AddbackSupport {
  status: AddbackSupportStatus;
  /** What the linked transactions add up to (net, as a positive amount). */
  supported: number;
  /** The claim they are compared with (the annual claim over the period the ledger covers). */
  claimed: number;
  /** Months the ledger covers, when that isn't a whole number of years (the claim was pro-rated to them). */
  periodMonths?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const YEAR_DAYS = 365.25;

/** Net total of the linked transactions, as a positive amount (a reversal nets off). */
export function supportedTotal(txs: SupportTransaction[]): number {
  const net = txs.reduce((s, t) => s + (Number.isFinite(Number(t.amount)) ? Number(t.amount) : 0), 0);
  return round2(Math.abs(net));
}

function txTime(t: { date?: string | null }): number | null {
  if (!t.date) return null;
  const ms = Date.parse(t.date);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The years a run of dated transactions covers: first to last date, plus one
 * gap between them (twelve monthly payments cover a year, three cover a
 * quarter, two December bonuses a year apart cover two years; a bank
 * statement's daily lines cover their dates). Null for fewer than two dates.
 */
export function coveredYears(txs: Array<{ date?: string | null }>): number | null {
  const days = Array.from(new Set(txs.map(txTime).filter((t): t is number => t !== null).map((t) => Math.floor(t / DAY)))).sort((a, b) => a - b);
  if (days.length < 2) return null;
  const span = days[days.length - 1] - days[0];
  if (span <= 0) return null;
  return (span + span / (days.length - 1)) / YEAR_DAYS;
}

/** A covered period within a month of a whole number of years is that many years. */
export function wholeYears(years: number): number | null {
  const k = Math.round(years);
  return k >= 1 && Math.abs(years - k) <= 1 / 12 ? k : null;
}

/**
 * The claim the linked transactions should add up to, over the period the
 * ledger covers (`ledger`: every transaction uploaded, else the linked ones):
 * one year's claim for a year of payments, two years' for two (each year's
 * own amount when the add-back states it), a quarter of the annual claim for
 * three months of bank statements. A one-time item, or a single payment, is
 * its claim as it stands.
 */
export function claimFor(claim: SupportClaim, txs: SupportTransaction[], ledger?: Array<{ date?: string | null }>): number {
  return claimOver(claim, txs, ledger).claimed;
}

function claimOver(claim: SupportClaim, txs: SupportTransaction[], ledger?: Array<{ date?: string | null }>): { claimed: number; periodMonths?: number } {
  const annual = Math.abs(Number(claim.annualAmount) || 0);
  const stated = claim.yearAmounts ?? {};
  const years = Array.from(new Set(txs.map((t) => (t.date ?? "").match(/\b((?:19|20)\d{2})\b/)?.[1]).filter((y): y is string => !!y)));
  const statedFor = (ys: string[]) => (ys.length > 0 && ys.every((y) => Number.isFinite(Number(stated[y]))) ? ys.reduce((s, y) => s + Math.abs(Number(stated[y])), 0) : null);
  const oneOff = /^(?:one_time|non_recurring)$/.test(String(claim.category ?? "")) || txs.filter((t) => txTime(t) !== null).length < 2;
  if (oneOff) {
    const one = years.length === 1 ? statedFor(years) : null;
    return { claimed: round2(one ?? annual) };
  }
  const covered = (ledger && coveredYears(ledger)) || coveredYears(txs) || 1;
  const k = wholeYears(covered);
  if (k !== null) {
    const byYear = years.length === k ? statedFor(years) : null;
    return { claimed: round2(byYear ?? annual * k) };
  }
  // Not a whole number of years (three months of statements, fifteen months of GL): pro-rated.
  return { claimed: round2(annual * covered), periodMonths: Math.max(1, Math.round(covered * 12)) };
}

/** Status of an add-back given the transactions linked to it (and the whole ledger they came from, when known). */
export function addbackSupport(claim: SupportClaim, txs: SupportTransaction[], ledger?: Array<{ date?: string | null }>): AddbackSupport {
  if (txs.length === 0) return { status: "no_match", supported: 0, claimed: round2(Math.abs(Number(claim.annualAmount) || 0)) };
  const supported = supportedTotal(txs);
  const { claimed, periodMonths } = claimOver(claim, txs, ledger);
  const period = periodMonths !== undefined ? { periodMonths } : {};
  if (supported === 0 || claimed <= 0) return { status: "partial_match", supported, claimed, ...period };
  const within = Math.abs(supported - claimed) <= ADDBACK_MATCH_TOLERANCE * claimed;
  return { status: within ? "matched" : supported > claimed ? "exceeds_claim" : "partial_match", supported, claimed, ...period };
}

/**
 * The amount of an add-back the evidence stands behind: the full claim when
 * matched (or when the payments exceed it — the claim is a portion of
 * them), only the supported part when partly supported (never more than the
 * claim, scaled to a year when the ledger covers another period), nothing
 * otherwise. A seller's confirmation of a partly supported add-back does not
 * make the rest evidenced.
 */
export function evidencedAmount(ab: {
  verificationStatus?: string | null;
  previousStatus?: string | null;
  annualAmount?: number | null;
  totalMatchedAmount?: number | null;
  claimedAmount?: number | null;
}): number {
  const annual = Math.abs(Number(ab.annualAmount) || 0);
  // A confirmed add-back counts in full (the seller's word where no ledger
  // holds it) — unless the ledger showed only part of it.
  const status = ab.verificationStatus === "seller_confirmed" && ab.previousStatus === "partial_match" ? "partial_match" : ab.verificationStatus;
  if (status === "matched" || status === "exceeds_claim" || status === "seller_confirmed") return annual;
  if (status === "partial_match") {
    const supported = Math.abs(Number(ab.totalMatchedAmount) || 0);
    const claimed = Math.abs(Number(ab.claimedAmount) || 0);
    // (Scaled to one year when the claim was compared over another period.)
    const perYear = claimed > 0 && annual > 0 ? supported * (annual / claimed) : supported;
    return Math.min(annual, round2(perYear));
  }
  return 0;
}

export interface StoredAddback extends SupportClaim {
  label?: string;
  verificationStatus?: string | null;
  previousStatus?: string | null;
  matchedTransactions?: SupportTransaction[] | null;
  totalMatchedAmount?: number | null;
  claimedAmount?: number | null;
}

/**
 * An add-back as the evidence stands, for rows stored before support was
 * worked out in code (a "partial_match" used to be saved as "matched",
 * with no supported total): a "matched" row's own linked transactions
 * decide. Returns the row with verificationStatus / previousStatus,
 * totalMatchedAmount and claimedAmount filled in.
 */
export function withEvidence<T extends StoredAddback>(ab: T): T {
  const txs = Array.isArray(ab.matchedTransactions) ? ab.matchedTransactions : [];
  const known = typeof ab.totalMatchedAmount === "number" && Number.isFinite(ab.totalMatchedAmount);
  const lookedMatched = ab.verificationStatus === "matched" || (ab.verificationStatus === "seller_confirmed" && ab.previousStatus === "matched");
  if (known || !lookedMatched || txs.length === 0) return ab;
  const s = addbackSupport(ab, txs);
  const out: T = { ...ab, totalMatchedAmount: s.supported, claimedAmount: s.claimed };
  if (s.status === "partial_match" || s.status === "exceeds_claim") {
    if (ab.verificationStatus === "matched") out.verificationStatus = s.status;
    else out.previousStatus = s.status;
  }
  return out;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** "about 3 months" / "about 1 year 3 months" — the period a claim was compared over. */
export function periodLabel(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  const parts = [y > 0 ? `${y} year${y === 1 ? "" : "s"}` : "", m > 0 ? `${m} month${m === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.join(" ");
}

/**
 * The claim a support figure was compared with, in words: "$60,000 claimed"
 * for a year's ledger; "$60,000 a year claimed ($15,000 for the 3 months the
 * ledger covers)" when the ledger covers another period.
 */
export function claimWords(annualAmount: number, claimedAmount: number | null | undefined): string {
  const annual = Math.abs(Number(annualAmount) || 0);
  const claimed = Math.abs(Number(claimedAmount) || 0);
  if (!claimed || annual <= 0 || Math.abs(claimed - annual) <= 0.01 * annual) return `${money(annual)} claimed`;
  const ratio = claimed / annual;
  const whole = wholeYears(ratio);
  if (whole !== null) return `${money(annual)} a year claimed (${money(claimed)} over the ${whole} years the ledger covers)`;
  return `${money(annual)} a year claimed (${money(claimed)} for the ${periodLabel(Math.max(1, Math.round(ratio * 12)))} the ledger covers)`;
}

/**
 * One add-back as the DD CIM's writer reads it: what was claimed and what the
 * ledger shows — never "matched" for a claim the transactions only partly
 * support, never "the rest is not evidenced" for a claim they exceed.
 */
export function addbackEvidenceLine(raw: StoredAddback): string {
  const ab = withEvidence(raw);
  const label = ab.label ?? "Add-back";
  const n = Array.isArray(ab.matchedTransactions) ? ab.matchedTransactions.length : 0;
  const claimed = Math.abs(Number(ab.annualAmount) || 0);
  const tx = `${n} supporting transaction${n === 1 ? "" : "s"}`;
  const shown = Math.abs(Number(ab.totalMatchedAmount) || 0);
  const confirmedAfter = (s: string) => ab.verificationStatus === "seller_confirmed" && ab.previousStatus === s;
  if (ab.verificationStatus === "partial_match" || confirmedAfter("partial_match")) {
    const confirmed = ab.verificationStatus === "seller_confirmed" ? "confirmed by the seller, but only partly supported" : "partly supported";
    return `- ${label}: ${confirmed} — ${claimWords(claimed, ab.claimedAmount)}; the ledger shows ${money(shown)} (${tx}); the rest is not evidenced by transactions`;
  }
  if (ab.verificationStatus === "exceeds_claim" || confirmedAfter("exceeds_claim")) {
    const portion = `${claimWords(claimed, ab.claimedAmount)} as the add-back portion of ${money(shown)} paid (${tx})`;
    return ab.verificationStatus === "seller_confirmed"
      ? `- ${label}: confirmed by the seller — ${portion}`
      : `- ${label}: the payments are in the ledger — ${portion}; the portion itself is a judgment to confirm, not shown by the transactions`;
  }
  switch (ab.verificationStatus) {
    case "matched":
      return `- ${label}: supported by the ledger — ${claimWords(claimed, ab.claimedAmount)}, ${money(shown || claimed)} in ${tx}`;
    case "seller_confirmed":
      return n > 0
        ? `- ${label}: confirmed by the seller — ${money(claimed)}, ${tx}`
        : `- ${label}: confirmed by the seller — ${money(claimed)}, no supporting transactions linked`;
    case "disputed":
      return `- ${label}: disputed by the seller`;
    case "no_match":
      return `- ${label}: ${money(claimed)} claimed; no supporting transactions found`;
    case "unverified":
    case undefined:
    case null:
    case "":
      return `- ${label}: ${money(claimed)} claimed; not yet checked against the ledger`;
    default:
      // A status this list doesn't know is passed on as recorded.
      return `- ${label}: ${ab.verificationStatus} — ${money(claimed)}, ${tx}`;
  }
}
