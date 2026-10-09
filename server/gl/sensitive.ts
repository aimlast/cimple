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
import { mentionsHeldName, screenText } from "../cim/sensitive-facts";
import { staffPrivateTopic } from "../cim/staff-private";
import { namesPerson, personsIn, type Person } from "./match";
import { GL_WITHHELD_WORDS } from "@shared/gl-evidence";

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

// ── Serve time: what a buyer may read of one entry (§9.2) ────────────────


export interface BuyerMaskContext {
  /** Staff the facts name (staffContextFrom). */
  staffNames: string[];
  /** Held or kept-out names (held staff-private people not switched back in, keep-out parties incl. the seller's own requests). */
  heldNames: string[];
  /** The add-back's own parties (the owner, the related party its label names): their entries are the point and stay. */
  parties: Person[];
  /** The entry belongs to a personal / discretionary / related-party add-back. */
  personalAddback: boolean;
  /** The broker's "show staff names" switch on the ledger. */
  showStaffNames: boolean;
}

export interface BuyerMaskedEntry {
  account: string;
  name: string | null;
  memo: string | null;
  withheld?: "personal" | "staff" | "keep_out";
}

export interface MaskableRow { account: string; name: string | null; memo: string | null }

/**
 * Account, card and government numbers in a name or description keep their
 * last 4: 7+ digits in a row, or 9+ digits split by spaces or dashes (a card,
 * a SIN, a phone). An invoice like "2024-118" stays.
 * INTEGRATOR: the data room's maskPersonalNumbers can replace this at the merge.
 */
export function maskLongNumbers(text: string | null): string | null {
  if (!text) return text;
  return text.replace(/\d(?:[\d\s-]{5,}\d)/g, (m) => {
    const digits = m.replace(/\D/g, "");
    const longestRun = Math.max(...m.split(/[\s-]+/).map((x) => x.length));
    return longestRun >= 7 || digits.length >= 9 ? `••••${digits.slice(-4)}` : m;
  });
}

/** A party of the add-back named in this text (the owner on "Payroll — D. Moretti"). */
function namesAParty(text: string, parties: Person[]): boolean {
  return !!text.trim() && parties.some((p) => namesPerson(text, p, parties));
}

/** A staff member's name in a staff-private context ("Bonus — Daniel, retention after he asked for a raise"). */
function staffPrivateMention(text: string, staffNames: string[]): boolean {
  if (!text.trim() || staffNames.length === 0) return false;
  if (!mentionsHeldName(text, staffNames)) return false;
  return staffPrivateTopic(text) !== null;
}

/**
 * One entry as a buyer may read it. Withheld rows keep date, account and
 * amount; their name and description are replaced by the reason. Recomputed
 * every time an entry is served — a newly held name, a keep-out request or
 * an unknown employee on a wages account is covered without reading the
 * ledger again.
 *
 * showDetails: the broker's per-entry choice — true shows a withheld entry
 * (the broker saw the warning), false withholds it, null = these rules.
 */
export function maskForBuyer(row: MaskableRow, ctx: BuyerMaskContext, showDetails: boolean | null = null): BuyerMaskedEntry {
  const account = row.account ?? "";
  const name = (row.name ?? "").trim() || null;
  const memo = (row.memo ?? "").trim() || null;
  const reveal = (): BuyerMaskedEntry => ({ account, name: maskLongNumbers(name), memo: maskLongNumbers(memo) });
  const withhold = (kind: "personal" | "staff" | "keep_out"): BuyerMaskedEntry => ({
    // A held name in the account itself goes too ("Consulting — Harvest Lane").
    account: kind === "keep_out" && ctx.heldNames.length > 0 && mentionsHeldName(account, ctx.heldNames) ? "Other account" : account,
    name: null,
    memo: GL_WITHHELD_WORDS[kind],
    withheld: kind,
  });
  if (showDetails === true) return reveal();
  if (showDetails === false) return withhold("keep_out");

  const words = `${name ?? ""} ${memo ?? ""}`;
  // A held or kept-out name, or a sensitive detail in the description (health, family matters).
  if (ctx.heldNames.length > 0 && (mentionsHeldName(words, ctx.heldNames) || mentionsHeldName(account, ctx.heldNames))) return withhold("keep_out");
  if (memo && screenText(memo) !== memo) return withhold("keep_out");
  // A personal medical or family cost on an owner-type account, or in a personal add-back.
  const medicalOrFamily = MEDICAL_RE.test(words) || FAMILY_RE.test(words) || MEDICAL_RE.test(account) || FAMILY_RE.test(account);
  if (medicalOrFamily && (PERSONAL_ACCOUNT_RE.test(account) || ctx.personalAddback)) return withhold("personal");
  // A staff member in a private context, anywhere.
  if (staffPrivateMention(words, ctx.staffNames)) return withhold("staff");
  // Every name on a payroll-type account is an employee's — unless it is the add-back's own party.
  if (PAYROLL_ACCOUNT_RE.test(account) && !ctx.showStaffNames) {
    if (name && !namesAParty(name, ctx.parties)) return withhold("staff");
    if (!name && memo && personsIn(memo).length > 0 && !namesAParty(memo, ctx.parties)) return withhold("staff");
    if (name && memo && personsIn(memo).some((p) => !ctx.parties.some((q) => q.last === p.last))) return withhold("staff");
  }
  return reveal();
}
