/**
 * sensitive.ts — ledger entries buyers must not read in full (gl spec §9.2).
 *
 * Two jobs:
 *  - classifyHint (ingest): a hint for the broker's review list — an
 *    employee's pay ("staff") or a personal medical/family cost on an
 *    owner-type account ("personal"). Only a hint.
 *  - maskForBuyer (serve time, pass 3): recomputed for every row served, so
 *    a newly held name or an unknown employee on a wages account is covered
 *    without reading the ledger again.
 */

/** Payroll-type accounts: the name on every row is an employee's (withheld from buyers unless it is the add-back's own party). */
export const PAYROLL_ACCOUNT_RE = /\b(?:wages?|salar(?:y|ies)|payroll|remuneration|employee benefits?|bonus(?:es)?|commissions?|vacation pay|cpp|ei expense|wsib)\b/i;

/** Medical words (a pharmacy, a clinic, therapy). */
export const MEDICAL_RE = /\b(?:pharm\w*|drug ?mart|rexall|shoppers|clinic|dental|dentist|orthodon\w*|physio\w*|chiro\w*|massage|hospital|medical|optometr\w*|optical|counsell?ing|psycholog\w*|therap\w*|naturopath\w*|fertility|prescription)\b/i;

/** Family words (childcare, school, events). */
export const FAMILY_RE = /\b(?:daycare|day care|tuition|school|college|camp|nanny|babysit\w*|kids?|child(?:ren)?|son|daughter|wedding|funeral|anniversary|gift for)\b/i;

/** Accounts that carry the owner's own costs. */
export const PERSONAL_ACCOUNT_RE = /\b(?:owner|shareholder|personal|draws?|due to|discretionary|officer)\b/i;

export type SensitiveHint = "personal" | "staff" | null;

/** The ingest-time hint for one entry. */
export function classifyHint(txn: { account: string; accountKey?: string | null; name?: string | null; memo?: string | null }): SensitiveHint {
  const acct = `${txn.account} ${txn.accountKey ?? ""}`;
  const words = `${txn.name ?? ""} ${txn.memo ?? ""}`;
  if (PERSONAL_ACCOUNT_RE.test(acct) && (MEDICAL_RE.test(words) || FAMILY_RE.test(words) || MEDICAL_RE.test(txn.account) || FAMILY_RE.test(txn.account))) {
    return "personal";
  }
  if (PAYROLL_ACCOUNT_RE.test(acct) && (txn.name ?? "").trim()) return "staff";
  return null;
}
