/**
 * match.ts — which ledger entries make up an add-back (gl spec §7.1). Pure
 * rules, $0, no model. The proposal run (match-run.ts) fetches candidate
 * entries per add-back and fiscal year; these functions score them and pick
 * a proposal the seller confirms or corrects.
 *
 *   whole account   an account named like the cost whose year total is the
 *                   cost (±2%) → every entry of it, high confidence
 *   one-off         one entry within $1 of the cost and named like it → high
 *   payroll         entries naming the person on a wages/payroll account
 *   otherwise       the best-scoring entries up to the cost (±15%)
 *
 * Scores: the account is named like the cost +4; the payee or description
 * names it +3 (a word the account name doesn't already carry); the person
 * the add-back names +4; the amount is the cost or a regular share of it
 * (monthly, bi-weekly, weekly…) +2; the same account as entries already
 * confirmed for this cost +3; a word from the broker's hint +3; already
 * confirmed for another cost −6. ≥7 high, 4–6 medium, below 4 never proposed.
 */
import { addbackTerms, TERM_STOP } from "./text";
import { classifyAccount, type AccountClass } from "./tie-out";
import { targetCents } from "@shared/gl-reconcile";
import type { GlCostSummary } from "@shared/gl-types";

export interface MatchEntry {
  ledgerId: string;
  rowNo: number;
  fiscalYear: string;
  txnDate: string;
  account: string;
  accountKey: string;
  accountNumber?: string | null;
  accountType?: string | null;
  name: string | null;
  memo: string | null;
  amountCents: number;
}

export interface MatchTrace {
  id: string;
  label: string;
  category: string | null;
  proof: string;
  sellerHint: string | null;
  sharePct: number | null;
  claims: Record<string, number>;
}

export interface Person {
  first: string;
  last: string;
}

export interface MatchContext {
  /** People the add-back is about (from its label; the owner's name for owner pay). */
  persons: Person[];
  /** Account keys of this cost's confirmed entries. */
  confirmedAccounts: ReadonlySet<string>;
  /** `${ledgerId}:${rowNo}` → the seller label of another cost that entry is confirmed for. */
  usedElsewhere: ReadonlyMap<string, string>;
  /** `${ledgerId}:${rowNo}` the seller or broker said is NOT part of this cost — never proposed again. */
  rejected: ReadonlySet<string>;
  /** The broker's account classes (tie-out), by account key. */
  classOverrides?: Record<string, AccountClass>;
  /** The chart is numbered (≥60% of accounts have numbers) — numbers decide the class. */
  numberedChart?: boolean;
}

export interface AccountYearTotal {
  accountKey: string;
  account: string;
  accountType?: string | null;
  accountNumber?: string | null;
  lines: number;
  netCents: number;
}

export interface Proposal {
  entry: MatchEntry;
  confidence: "high" | "medium";
  reason: string;
  score: number;
}

export const entryKey = (e: { ledgerId: string | null; rowNo: number | null }) => `${e.ledgerId}:${e.rowNo}`;

// ── Words ────────────────────────────────────────────────────────────────

/** Words that say nothing about WHERE a cost sits in the books (they'd match half the ledger). */
const MATCH_STOP = new Set([
  ...Array.from(TERM_STOP),
  "owner", "owners", "personal", "excess", "related", "party", "spouse", "president", "compensation", "use", "estimate", "estimated",
  "discretionary", "family", "company", "business", "one-time", "time", "recurring", "non-recurring", "nonrecurring", "share",
  "half", "salary", "salaries", "wages", "wage", "pay", "payroll", "remuneration", "benefit", "benefits", "management", "manager",
  "general", "other", "misc", "miscellaneous", "and", "fees", "fee", "costs", "charges", "charge", "the", "vehicles", "expenses",
]);

/** What kind of cost it is — decides the extra words it is looked for by. */
export type CostKind = "vehicle" | "meals" | "club" | "life_insurance" | "settlement" | "consulting" | "pay" | "other";

export function costKind(t: Pick<MatchTrace, "label" | "category" | "proof">): CostKind {
  const l = t.label.toLowerCase();
  if (t.proof === "payroll" || t.category === "owner_comp") return "pay";
  if (/\b(vehicle|auto|car|truck|lexus|fuel|lease)\b/.test(l)) return "vehicle";
  if (/\b(meal|meals|entertain\w*|restaurant|dining)\b/.test(l)) return "meals";
  if (/\b(golf|club|country club|dues|membership)\b/.test(l)) return "club";
  if (/\blife\b.*\binsurance\b|\binsurance\b.*\blife\b/.test(l)) return "life_insurance";
  if (/\b(settlement|severance|legal|lawsuit|dismissal|litigation)\b/.test(l)) return "settlement";
  if (/\b(consult\w*|implementation|migration)\b/.test(l)) return "consulting";
  return "other";
}

const KIND_WORDS: Record<CostKind, string[]> = {
  vehicle: ["vehicle", "auto", "car", "truck", "fuel", "gas", "petro", "esso", "shell", "chevron", "ultramar", "husky", "irving", "pioneer", "lease", "insurance", "repairs", "tires", "parking", "407"],
  meals: ["meal", "meals", "restaurant", "entertainment", "dining"],
  club: ["golf", "club", "country", "dues", "membership"],
  life_insurance: ["life", "policy", "premium", "manulife", "sun life", "canada life", "great-west", "rbc insurance", "insurance"],
  settlement: ["settlement", "legal", "lawyer", "law", "llp", "severance"],
  consulting: ["consult", "consultant", "consulting", "implementation", "migration"],
  pay: ["salary", "wages", "payroll", "officer", "management"],
  other: [],
};

/** Words the cost is looked for by (each ≥3 characters, lower case): its own words + its kind's. */
export function termsFor(t: Pick<MatchTrace, "label" | "category" | "proof">): string[] {
  const own = addbackTerms({ label: t.label.replace(/\([^)]*%[^)]*\)/g, " "), category: "" }).filter((w) => !MATCH_STOP.has(w));
  return Array.from(new Set([...own, ...KIND_WORDS[costKind(t)]])).filter((w) => w.length >= 3).slice(0, 40);
}

/** Words from the broker's hint that aren't the default hint's (a hint the broker typed: "the Lexus and the boat"). */
export function hintWords(hint: string | null | undefined, terms: string[]): string[] {
  if (!hint) return [];
  return Array.from(new Set(hint.toLowerCase().split(/[^a-z0-9-]+/)))
    .filter((w) => w.length >= 4 && !MATCH_STOP.has(w) && !terms.includes(w) && !DEFAULT_HINT_WORDS.has(w))
    .slice(0, 10);
}
const DEFAULT_HINT_WORDS = new Set([
  "fuel", "insurance", "lease", "loan", "payments", "repairs", "vehicle", "vehicle(s)", "restaurant", "entertainment", "slips", "year-end",
  "summary", "premium", "policy", "payment", "letter", "invoice", "membership", "dues", "club", "consultant's", "invoices", "entries",
  "make", "cost", "this", "your", "their",
]);

const wordRe = (w: string) => new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
const hits = (text: string, words: string[]) => words.filter((w) => wordRe(w).test(text));

/** People named in a label: "Owner compensation (President - Tony Moretti)" → Tony Moretti. */
const NOT_A_NAME = new Set([
  "Owner", "Owners", "Related", "Party", "Salary", "President", "Spouse", "Employment", "Meals", "Golf", "Club", "Excess", "Life", "Insurance",
  "Personal", "Vehicle", "Vehicles", "Wrongful", "Dismissal", "Settlement", "Management", "Fees", "Fee", "General", "Manager", "Compensation",
  "Director", "Officer", "Canada", "Sun", "Great", "West", "Petro", "The", "And", "One", "Time", "Interest", "Income", "Taxes", "Depreciation",
  "Amortization", "Consulting", "Migration", "Legal", "Professional", "Wages", "Payroll", "Bonus", "Dividend", "Dividends", "Rent", "Car",
]);
export function personsIn(text: string): Person[] {
  const out: Person[] = [];
  const re = /\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?|[A-Z]\.)\s+([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\b/g;
  for (const m of Array.from(text.matchAll(re))) {
    const [first, last] = [m[1].replace(/\.$/, ""), m[2]];
    if (NOT_A_NAME.has(first) || NOT_A_NAME.has(last)) continue;
    out.push({ first: first.toLowerCase(), last: last.toLowerCase() });
  }
  return out;
}

/**
 * Does the text name this person? The surname with their first name or
 * initial ("Payroll — D. Brightwater", "Brightwater, Dan"); a different
 * initial or first name before the surname is someone else ("E.
 * Brightwater" is not Dan). The surname alone counts only when nobody else
 * of that surname is involved.
 */
export function namesPerson(text: string, p: Person, others: Person[] = []): boolean {
  const toks = text.toLowerCase().split(/[^a-z'-]+/).filter(Boolean);
  let bare = false;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== p.last) continue;
    const prev = toks[i - 1];
    if (prev === p.first || prev === p.first[0]) return true;
    const someoneElse = !!prev && (prev.length === 1 || others.some((o) => o.first === prev));
    if (!someoneElse) bare = true;
  }
  if (toks.includes(p.last) && toks.includes(p.first)) return true;
  if (!bare) return false;
  return !others.some((o) => o.last === p.last && o.first !== p.first);
}

const PAYROLL_ACCOUNT = /\b(?:wages?|salar(?:y|ies)|payroll|remuneration|officers?|management (?:salary|fees?)|compensation)\b/i;

// ── Scoring ──────────────────────────────────────────────────────────────

const PERIODS = [1, 2, 4, 12, 24, 26, 52];

function amountHit(amount: number, target: number): number | null {
  const a = Math.abs(amount);
  for (const p of PERIODS) {
    const share = Math.abs(target) / p;
    if (share > 0 && Math.abs(a - share) <= share * 0.02) return p;
  }
  return null;
}

const PERIOD_WORD: Record<number, string> = { 1: "Same amount", 2: "Half-yearly", 4: "Quarterly", 12: "Monthly", 24: "Twice a month", 26: "Every two weeks", 52: "Weekly" };
const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: Math.abs(c) % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Balance-sheet and revenue accounts never hold a cost — unless the account itself is named like it ("Shareholder loan" for draws). */
function excludedAccount(e: Pick<MatchEntry, "account" | "accountKey" | "accountNumber" | "accountType">, terms: string[], ctx: MatchContext): boolean {
  const cls = classifyAccount(e.account, e.accountNumber ?? null, e.accountType ?? null, ctx.classOverrides ?? {}, ctx.numberedChart ?? false, e.accountKey);
  if (cls !== "balance_sheet" && cls !== "revenue") return false;
  return hits(e.account, terms).length === 0;
}

export function scoreEntry(
  e: MatchEntry,
  trace: MatchTrace,
  target: number,
  terms: string[],
  hint: string[],
  ctx: MatchContext,
): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];
  const acctHits = hits(e.account, terms);
  if (acctHits.length) score += 4;
  const text = `${e.name ?? ""} ${e.memo ?? ""}`;
  const textHits = hits(text, terms).filter((w) => !acctHits.includes(w) && !wordRe(w).test(e.account));
  if (textHits.length) {
    score += 3;
    reasons.push(`Names ${textHits[0].replace(/\b\w/g, (c) => c.toUpperCase())}`);
  }
  if (ctx.persons.some((p) => namesPerson(text, p, ctx.persons))) {
    score += 4;
    reasons.unshift("Names the person");
  }
  const period = amountHit(e.amountCents, target);
  if (period !== null) {
    score += 2;
    reasons.push(period === 1 ? "Same amount" : `${PERIOD_WORD[period]} ${money(e.amountCents)}`);
  }
  if (ctx.confirmedAccounts.has(e.accountKey)) {
    score += 3;
    reasons.unshift("Same account");
  }
  if (hint.length && hits(`${e.account} ${text}`, hint).length) {
    score += 3;
    reasons.push("Matches your broker's note");
  }
  const other = ctx.usedElsewhere.get(entryKey(e));
  if (other) {
    score -= 6;
    reasons.push(`Already used for ${other}`);
  }
  if (!reasons.length && acctHits.length) reasons.push("Same kind of account");
  return { score, reason: reasons[0] ?? "Looks like this cost" };
}

const confidenceOf = (score: number): "high" | "medium" | "low" => (score >= 7 ? "high" : score >= 4 ? "medium" : "low");

// ── Proposals ────────────────────────────────────────────────────────────

/** Accounts named like the cost whose year total is the cost (±2%) — the whole account is the cost. Best first. */
export function wholeAccountCandidates(trace: MatchTrace, year: string, totals: AccountYearTotal[], ctx: MatchContext): AccountYearTotal[] {
  const target = targetCents(Number(trace.claims[year] ?? 0), trace.sharePct);
  if (!target || trace.proof === "payroll") return [];
  const terms = termsFor(trace);
  return totals
    .filter((a) => a.netCents > 0 && hits(a.account, terms).length > 0)
    .filter((a) => !excludedAccount({ account: a.account, accountKey: a.accountKey, accountNumber: a.accountNumber, accountType: a.accountType }, terms, ctx))
    .filter((a) => Math.abs(a.netCents - target) <= Math.max(Math.abs(target) * 0.02, 100))
    .sort((a, b) => hits(b.account, terms).length - hits(a.account, terms).length || Math.abs(a.netCents - target) - Math.abs(b.netCents - target));
}

/**
 * The proposal for one cost in one fiscal year (pure). `candidates`: the
 * entries the candidate query found; `wholeAccountRows`: every entry of the
 * best whole-account match (when there is one).
 */
export function proposeYear(
  trace: MatchTrace,
  year: string,
  candidates: MatchEntry[],
  ctx: MatchContext,
  wholeAccount: { account: AccountYearTotal; rows: MatchEntry[] } | null = null,
): { proposals: Proposal[]; confident: boolean } {
  const target = targetCents(Number(trace.claims[year] ?? 0), trace.sharePct);
  if (!target || trace.proof === "statement") return { proposals: [], confident: false };
  const terms = termsFor(trace);
  const hint = hintWords(trace.sellerHint, terms);
  const allowed = (e: MatchEntry) => e.fiscalYear === year && !ctx.rejected.has(entryKey(e));

  // 1. The whole account.
  if (wholeAccount && wholeAccount.rows.length > 0) {
    const rows = wholeAccount.rows.filter(allowed);
    const sum = rows.reduce((s, e) => s + e.amountCents, 0);
    if (Math.abs(sum - target) <= Math.max(Math.abs(target) * 0.02, 100)) {
      const reason = `The whole ${wholeAccount.account.account.split(":").pop()} account`;
      const proposals = rows.map((e) => ({ entry: e, confidence: "high" as const, reason, score: 9 }));
      return { proposals, confident: true };
    }
  }

  const scored = candidates
    .filter(allowed)
    .filter((e) => !excludedAccount(e, terms, ctx))
    .map((e) => ({ e, ...scoreEntry(e, trace, target, terms, hint, ctx) }))
    .filter((x) => confidenceOf(x.score) !== "low");

  // 2. A one-off: one entry of the amount, named like the cost.
  if (trace.proof === "one_off") {
    const exact = scored.filter((x) => x.e.amountCents > 0 && Math.abs(x.e.amountCents - target) <= 100 && x.score >= 4 + 2);
    if (exact.length > 0) {
      const best = exact.sort((a, b) => b.score - a.score)[0];
      return { proposals: [{ entry: best.e, confidence: "high", reason: best.reason, score: best.score }], confident: true };
    }
    const pos = scored.filter((x) => x.e.amountCents > 0);
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        if (Math.abs(pos[i].e.amountCents + pos[j].e.amountCents - target) <= 100) {
          return {
            proposals: [pos[i], pos[j]].map((x) => ({ entry: x.e, confidence: "medium" as const, reason: x.reason, score: x.score })),
            confident: false,
          };
        }
      }
    }
  }

  // 3. Pay: entries naming the person on a payroll-type account.
  if (trace.proof === "payroll") {
    const named = scored.filter((x) => x.e.amountCents > 0 && PAYROLL_ACCOUNT.test(x.e.account) && ctx.persons.some((p) => namesPerson(`${x.e.name ?? ""} ${x.e.memo ?? ""}`, p, ctx.persons)));
    if (named.length === 0) return { proposals: [], confident: false };
    const sum = named.reduce((s, x) => s + x.e.amountCents, 0);
    const within = Math.abs(sum - target) <= Math.abs(target) * 0.15;
    const proposals = named.map((x) => ({ entry: x.e, confidence: within ? ("high" as const) : ("medium" as const), reason: "Names the person", score: x.score }));
    return { proposals, confident: within };
  }

  // 4. Otherwise: the best entries up to the cost (±15%), strongest first.
  const pool = scored
    .filter((x) => x.e.amountCents > 0)
    .sort((a, b) => b.score - a.score || (a.e.txnDate < b.e.txnDate ? -1 : 1));
  const picked: typeof pool = [];
  let sum = 0;
  for (const x of pool) {
    if (sum >= target * 0.98) break;
    if (sum + x.e.amountCents > target * 1.15) continue;
    picked.push(x);
    sum += x.e.amountCents;
  }
  const proposals = picked.map((x) => ({ entry: x.e, confidence: confidenceOf(x.score) as "high" | "medium", reason: x.reason, score: x.score }));
  return { proposals, confident: isConfident(proposals.map((p) => ({ confidence: p.confidence, amountCents: p.entry.amountCents })), target) };
}

/** The high-confidence entries reach the cost: ≥85% of it, at most 115%. */
export function isConfident(links: Array<{ confidence?: string | null; amountCents: number }>, target: number): boolean {
  if (!target) return false;
  const high = Math.abs(links.filter((l) => l.confidence === "high").reduce((s, l) => s + Number(l.amountCents || 0), 0));
  return high >= Math.abs(target) * 0.85 && high <= Math.abs(target) * 1.15;
}

/**
 * "We found these in your books: Vehicle – Owner account, 2022–2024,
 * $78,000 in total." Only when every claimed year a seller-visible ledger
 * covers is confident from high-confidence entries (proposed or confirmed),
 * every claimed year IS covered, and they sit in at most 3 accounts (pure).
 */
export function costSummary(
  trace: Pick<MatchTrace, "claims" | "sharePct" | "proof"> & { leftOut?: { years: string[] } | null },
  links: Array<{ fiscalYear: string; state: string; ledgerId: string | null; confidence?: string | null; amountCents: number; account?: string | null }>,
  sellerLedgerYears: ReadonlySet<string>,
  sellerLedgerIds: ReadonlySet<string>,
): GlCostSummary | null {
  if (trace.proof === "statement") return null;
  const years = Object.keys(trace.claims).filter((y) => /^\d{4}$/.test(y) && !trace.leftOut?.years?.includes(y)).sort();
  if (years.length === 0) return null;
  const accounts = new Set<string>();
  let total = 0;
  for (const y of years) {
    if (!sellerLedgerYears.has(y)) return null;
    const target = targetCents(Number(trace.claims[y] ?? 0), trace.sharePct);
    const mine = links.filter((l) => l.fiscalYear === y && l.ledgerId && sellerLedgerIds.has(l.ledgerId) && (l.state === "proposed" || l.state === "confirmed") && l.confidence === "high");
    if (!isConfident(mine, target)) return null;
    for (const l of mine) if (l.account) accounts.add(l.account);
    total += mine.reduce((s, l) => s + Number(l.amountCents || 0), 0);
  }
  if (accounts.size === 0 || accounts.size > 3) return null;
  return { accounts: Array.from(accounts).sort(), years, totalCents: Math.abs(total) };
}
