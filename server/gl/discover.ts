/**
 * discover.ts — "Possible add-backs we noticed in the ledger" (gl spec D20,
 * P1). Rules only, never added on their own: accounts that usually hold the
 * owner's personal costs (owner, shareholder, personal, donations, club,
 * life insurance) that no add-back already covers, and large one-off legal
 * or settlement payments no add-back holds. The broker decides — "Add as
 * an add-back" opens the Normalization tab's custom add-back.
 */
import type { DealAccountTotal } from "./store";
import type { GlTransaction } from "@shared/schema";
import { formatDay } from "@shared/gl-copy";

export interface PossibleAddback {
  accountKey: string;
  account: string;
  years: Record<string, number>;
  totalCents: number;
  why: string;
}

const PERSONAL_ACCOUNT: Array<[RegExp, string]> = [
  [/\b(shareholder|owner)'?s?\b.*\b(expenses?|costs?|personal)\b|\bpersonal\b/i, "An account for the owner's own costs"],
  [/\b(donations?|charit\w*)\b/i, "Donations are usually the owner's choice"],
  [/\b(golf|country club|club dues|memberships?)\b/i, "Club memberships are often personal"],
  [/\blife insurance\b/i, "Life insurance on the owner is usually personal"],
];
const NOT_PERSONAL = /\b(loan|payable|receivable|draws?|dividends?|capital|equity|retained)\b/i;

/** Accounts worth a look, not covered by an add-back's entries (pure). */
export function possibleAddbacks(totals: DealAccountTotal[], coveredAccounts: ReadonlySet<string>, minCents = 100_000): PossibleAddback[] {
  const byKey = new Map<string, PossibleAddback>();
  for (const t of totals) {
    if (t.netCents <= 0 || coveredAccounts.has(t.account) || NOT_PERSONAL.test(t.account)) continue;
    const hit = PERSONAL_ACCOUNT.find(([re]) => re.test(t.account));
    if (!hit) continue;
    const p = byKey.get(t.accountKey) ?? { accountKey: t.accountKey, account: t.account, years: {}, totalCents: 0, why: hit[1] };
    p.years[t.fiscalYear] = (p.years[t.fiscalYear] ?? 0) + t.netCents;
    p.totalCents += t.netCents;
    byKey.set(t.accountKey, p);
  }
  return Array.from(byKey.values()).filter((p) => p.totalCents >= minCents).sort((a, b) => b.totalCents - a.totalCents).slice(0, 12);
}

/** Words of a one-off legal or settlement payment. */
export const ONE_OFF_TERMS = ["settlement", "severance", "lawsuit", "litigation", "legal", "lawyer", "llp", "wrongful", "arbitration", "tribunal"];
const ONE_OFF_RE = /\b(?:settlement|severance|lawsuit|litigation|legal|lawyers?|llp|wrongful|arbitration|tribunal)\b/i;
const NOT_EXPENSE = /\b(?:loan|payable|receivable|bank|chequing|checking|savings|cash|accrued|deposit|retainer held|hst|gst|tax)\b/i;

/**
 * Large one-off legal or settlement payments (≥ $5,000 each by default)
 * that no add-back already holds (pure). Shown beside the accounts, one
 * line per entry.
 */
export function possibleOneOffs(rows: Array<Pick<GlTransaction, "ledgerId" | "rowNo" | "fiscalYear" | "txnDate" | "account" | "name" | "memo" | "amountCents" | "duplicate">>, linked: ReadonlySet<string>, minCents = 500_000): PossibleAddback[] {
  const out: PossibleAddback[] = [];
  for (const r of rows) {
    if (r.duplicate || Number(r.amountCents) < minCents || linked.has(`${r.ledgerId}:${r.rowNo}`)) continue;
    if (NOT_EXPENSE.test(r.account)) continue;
    if (!ONE_OFF_RE.test(`${r.account} ${r.name ?? ""} ${r.memo ?? ""}`)) continue;
    const who = (r.name || r.memo || r.account).trim();
    out.push({
      accountKey: `entry:${r.ledgerId}:${r.rowNo}`,
      account: `${who} — ${formatDay(r.txnDate)} (${r.account})`,
      years: { [r.fiscalYear]: Number(r.amountCents) },
      totalCents: Number(r.amountCents),
      why: "A large legal or settlement payment — often one-time",
    });
  }
  return out.sort((a, b) => b.totalCents - a.totalCents).slice(0, 8);
}
