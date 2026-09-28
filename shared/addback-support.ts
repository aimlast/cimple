/**
 * How far the transactions linked to an add-back support its claimed amount
 * — worked out in code from the transactions themselves, never taken from
 * the model's own total. Used by the server (after matching) and the add-back
 * screen (after the broker links transactions by hand), so both say the same.
 *
 *  matched        the linked transactions add up to within 15% of the claim
 *  partial_match  some support exists, but the amounts differ materially
 *                 (a $60,000 vehicle add-back with $12,000 of vehicle charges)
 *  no_match       nothing linked
 */

/** A claim is "matched" when the supporting transactions are within this share of it. */
export const ADDBACK_MATCH_TOLERANCE = 0.15;

export type AddbackSupportStatus = "matched" | "partial_match" | "no_match";

export interface SupportTransaction {
  amount: number;
  date?: string | null;
}

export interface SupportClaim {
  annualAmount: number;
  yearAmounts?: Record<string, number> | null;
}

export interface AddbackSupport {
  status: AddbackSupportStatus;
  /** What the linked transactions add up to (net, as a positive amount). */
  supported: number;
  /** The claim they are compared with (the annual claim × the years the transactions span). */
  claimed: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Net total of the linked transactions, as a positive amount (a reversal nets off). */
export function supportedTotal(txs: SupportTransaction[]): number {
  const net = txs.reduce((s, t) => s + (Number.isFinite(Number(t.amount)) ? Number(t.amount) : 0), 0);
  return round2(Math.abs(net));
}

function txTime(t: SupportTransaction): number | null {
  if (!t.date) return null;
  const ms = Date.parse(t.date);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The claim the linked transactions should add up to: one year's claim for
 * transactions within a year (twelve monthly salary payments), two years'
 * for a two-year ledger. When the add-back states each of those years, their
 * own amounts.
 */
export function claimFor(claim: SupportClaim, txs: SupportTransaction[]): number {
  const times = txs.map(txTime).filter((t): t is number => t !== null);
  // The span the payments cover, plus one payment period (12 monthly payments ≈ one year).
  const spanYears = times.length > 1
    ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times) + 30 * 86_400_000) / (365 * 86_400_000)))
    : 1;
  const years = Array.from(new Set(txs.map((t) => (t.date ?? "").match(/\b((?:19|20)\d{2})\b/)?.[1]).filter((y): y is string => !!y)));
  const stated = claim.yearAmounts ?? {};
  if (years.length === spanYears && years.length > 0 && years.every((y) => Number.isFinite(Number(stated[y])))) {
    return round2(years.reduce((s, y) => s + Math.abs(Number(stated[y])), 0));
  }
  return round2(Math.abs(Number(claim.annualAmount) || 0) * spanYears);
}

/** Status of an add-back given the transactions linked to it. */
export function addbackSupport(claim: SupportClaim, txs: SupportTransaction[]): AddbackSupport {
  if (txs.length === 0) return { status: "no_match", supported: 0, claimed: round2(Math.abs(Number(claim.annualAmount) || 0)) };
  const supported = supportedTotal(txs);
  const claimed = claimFor(claim, txs);
  if (supported === 0) return { status: "partial_match", supported, claimed };
  const within = claimed > 0 && Math.abs(supported - claimed) <= ADDBACK_MATCH_TOLERANCE * claimed;
  return { status: within ? "matched" : "partial_match", supported, claimed };
}

/**
 * The amount of an add-back the evidence stands behind: the full claim when
 * matched, only the supported part when partly supported (never more than
 * the claim), nothing otherwise. A seller's confirmation of a partly
 * supported add-back does not make the rest evidenced.
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
  if (status === "matched" || status === "seller_confirmed") return annual;
  if (status === "partial_match") {
    const supported = Math.abs(Number(ab.totalMatchedAmount) || 0);
    const claimed = Math.abs(Number(ab.claimedAmount) || 0);
    // (Scaled back to one year when the support spans several.)
    const perYear = claimed > annual && annual > 0 ? supported * (annual / claimed) : supported;
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
  if (s.status === "partial_match") {
    if (ab.verificationStatus === "matched") out.verificationStatus = "partial_match";
    else out.previousStatus = "partial_match";
  }
  return out;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * One add-back as the DD CIM's writer reads it: what was claimed and what the
 * ledger shows — never "matched" for a claim the transactions only partly
 * support.
 */
export function addbackEvidenceLine(raw: StoredAddback): string {
  const ab = withEvidence(raw);
  const label = ab.label ?? "Add-back";
  const n = Array.isArray(ab.matchedTransactions) ? ab.matchedTransactions.length : 0;
  const claimed = Math.abs(Number(ab.annualAmount) || 0);
  const tx = `${n} supporting transaction${n === 1 ? "" : "s"}`;
  const partial = ab.verificationStatus === "partial_match" || (ab.verificationStatus === "seller_confirmed" && ab.previousStatus === "partial_match");
  if (partial) {
    const shown = Math.abs(Number(ab.totalMatchedAmount) || 0);
    const over = Math.abs(Number(ab.claimedAmount) || 0);
    const base = over > claimed ? `${money(over)} claimed over the ledger's period` : `${money(claimed)} claimed`;
    const confirmed = ab.verificationStatus === "seller_confirmed" ? "confirmed by the seller, but only partly supported" : "partly supported";
    return `- ${label}: ${confirmed} — ${base}; the ledger shows ${money(shown)} (${tx}); the rest is not evidenced by transactions`;
  }
  switch (ab.verificationStatus) {
    case "matched": {
      const shown = Math.abs(Number(ab.totalMatchedAmount) || 0);
      const over = Math.abs(Number(ab.claimedAmount) || 0);
      return over > claimed && shown > 0
        ? `- ${label}: supported by the ledger — ${money(over)} claimed over the ledger's period, ${money(shown)} in ${tx}`
        : `- ${label}: supported by the ledger — ${money(claimed)} claimed, ${money(shown || claimed)} in ${tx}`;
    }
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
