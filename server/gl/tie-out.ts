/**
 * tie-out.ts — does the ledger agree with the financial statements? (gl spec
 * §6.6, D21). Deterministic, per fiscal year: the ledger's revenue and net
 * income against the analysis's statements. "Found in the books" means
 * little if the books don't match the statements, so the Full and Blind
 * notes only speak for years that agree (or whose difference the broker
 * accepted with a note).
 *
 * The pure core (`classifyAccount`, `tieOutYear`, `tieOutWords`) is unit
 * tested; `tieOutFor` loads the ledger totals and the statements and caches
 * the result on gl_tracing.tie_out.
 */
import type { GlTieOutYear } from "@shared/gl-types";
import { formatCents, yearsWords } from "@shared/gl-copy";

export type AccountClass = "revenue" | "expense" | "balance_sheet" | "unknown";

// ── Account classes ──────────────────────────────────────────────────────

const TYPE_REVENUE = /\b(income|revenue|sales|other income)\b/i;
const TYPE_EXPENSE = /\b(expense|expenses|cost of goods sold|cogs|cost of sales|direct costs?|overhead|depreciation|amorti[sz]ation|other expense)\b/i;
const TYPE_BALANCE = /\b(bank|cash|current asset|fixed asset|non-?current asset|asset|inventory|liabilit(?:y|ies)|credit card|equity|accounts? receivable|accounts? payable|receivable|payable|prepayment|depreciation asset)\b/i;

const NAME_BALANCE = new RegExp(
  [
    "\\bbank\\b", "\\bcash\\b", "chequing", "checking", "savings", "receivable", "inventory", "prepaid", "\\bdeposits?\\b", "accumulated",
    "payable", "accrued", "\\bloans?\\b", "line of credit", "mortgage", "\\b(?:gst|hst|pst|qst|vat)\\b", "sales tax", "payroll liabilit",
    "source deduction", "due to", "due from", "shareholder loan", "\\bequity\\b", "retained", "capital stock", "share capital",
    "dividends?", "\\bdraws?\\b", "drawings", "opening balance", "undeposited", "clearing", "suspense", "visa\\b", "mastercard", "amex\\b", "credit card",
  ].join("|"),
  "i",
);
const NAME_FIXED_ASSET = /^(?:vehicles?|equipment|computer equipment|furniture(?: (?:and|&) fixtures)?|leasehold improvements?|buildings?|land|tools and equipment|machinery)$/i;
const NAME_EXPENSE_WORD = /\b(expense|expenses|repairs?|maintenance|fuel|insurance|lease|rent|costs?|fees?|supplies)\b/i;
const NAME_REVENUE = /\b(revenue|sales|fees earned|income)\b/i;
const NOT_REVENUE = /\b(income tax(?:es)?|cost of sales|sales tax|expense|expenses|commissions?|marketing|costs?)\b/i;

/**
 * The class of an account: the broker's choice → the export's account type →
 * the account number (when the chart is numbered: 1000–3999 balance sheet,
 * 4000–4999 revenue, 5000–9999 expense) → the name's words → unknown.
 * Anything else that has a name and isn't the balance sheet or revenue is
 * an expense (the usual case in a ledger).
 */
export function classifyAccount(
  account: string,
  accountNumber: string | null,
  accountType: string | null,
  overrides: Record<string, AccountClass | "revenue" | "expense" | "balance_sheet"> = {},
  numberedChart = false,
  accountKeyValue?: string,
): AccountClass {
  const key = accountKeyValue ?? account.toLowerCase();
  const o = overrides[key];
  if (o === "revenue" || o === "expense" || o === "balance_sheet") return o;
  const type = (accountType ?? "").trim();
  if (type) {
    if (TYPE_BALANCE.test(type) && !/expense|cost/i.test(type)) return "balance_sheet";
    if (TYPE_EXPENSE.test(type)) return "expense";
    if (TYPE_REVENUE.test(type)) return "revenue";
  }
  if (numberedChart && accountNumber) {
    const n = Number(String(accountNumber).replace(/[^\d]/g, "").slice(0, 4));
    if (n >= 1000 && n <= 3999) return "balance_sheet";
    if (n >= 4000 && n <= 4999) return "revenue";
    if (n >= 5000 && n <= 9999) return "expense";
  }
  const leaf = account.split(":").map((p) => p.trim()).filter(Boolean);
  const name = leaf.join(" ");
  const last = leaf[leaf.length - 1] ?? name;
  if (NAME_BALANCE.test(name) && !/\b(interest|bank charges?|bank fees?|service charges?|merchant fees?)\b/i.test(name)) return "balance_sheet";
  if (NAME_FIXED_ASSET.test(last) && !NAME_EXPENSE_WORD.test(name)) return "balance_sheet";
  if (NAME_REVENUE.test(name) && !NOT_REVENUE.test(name)) return "revenue";
  if (/[a-z]/i.test(name)) return "expense";
  return "unknown";
}

// ── One year ─────────────────────────────────────────────────────────────

export interface TieOutAccount {
  accountKey: string;
  account: string;
  accountType?: string | null;
  accountNumber?: string | null;
  netCents: number;
}

export interface TieOutStatements {
  revenueCents?: number | null;
  netIncomeCents?: number | null;
  /** The statements' amortization + income-tax rows (the accountant's usual year-end entries). */
  yearEndCents?: number | null;
}

export interface TieOutYearInput {
  accounts: TieOutAccount[];
  statements: TieOutStatements | null;
  overrides?: Record<string, AccountClass | "revenue" | "expense" | "balance_sheet">;
  numberedChart?: boolean;
  basis: "accrual" | "cash" | null;
  /** Months of the fiscal year the ledger covers. */
  monthsCovered: number;
  /** The ledger has entries on amortization / income-tax accounts this year. */
  hasYearEndAccounts: boolean;
}

/** The tie-out of one fiscal year (pure). */
export function tieOutYear(input: TieOutYearInput): GlTieOutYear {
  const cls = (a: TieOutAccount) => classifyAccount(a.account, a.accountNumber ?? null, a.accountType ?? null, input.overrides ?? {}, input.numberedChart ?? false, a.accountKey);
  let revenue = 0;
  let pnl = 0;
  const unknown: Array<{ accountKey: string; account: string; netCents: number }> = [];
  for (const a of input.accounts) {
    const c = cls(a);
    if (c === "revenue") {
      revenue += -a.netCents;
      pnl += a.netCents;
    } else if (c === "expense") {
      pnl += a.netCents;
    } else if (c === "unknown") {
      unknown.push({ accountKey: a.accountKey, account: a.account, netCents: a.netCents });
    }
  }
  const ledgerNet = -pnl;
  const st = input.statements;
  const out: GlTieOutYear = { state: "cannot_check", likelyReason: null };
  if (!st || (st.revenueCents === null || st.revenueCents === undefined) || (st.netIncomeCents === null || st.netIncomeCents === undefined)) {
    return { ...out, likelyReason: "no_statements", ...(st?.revenueCents != null ? { revenue: { statements: st.revenueCents!, ledger: revenue } } : {}) };
  }
  out.revenue = { statements: st.revenueCents, ledger: revenue };
  out.netIncome = { statements: st.netIncomeCents, ledger: ledgerNet };
  const tol = Math.max(100_000, Math.abs(st.revenueCents) * 0.005);
  if (input.monthsCovered < 11) return { ...out, likelyReason: "partial_year" };
  const unknownTotal = unknown.reduce((s, u) => s + Math.abs(u.netCents), 0);
  if (unknownTotal > tol) return { ...out, likelyReason: "unclassified_accounts", unclassified: unknown.sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents)).slice(0, 40) };
  const dRev = revenue - st.revenueCents;
  const dNet = ledgerNet - st.netIncomeCents;
  if (Math.abs(dRev) <= tol && Math.abs(dNet) <= tol) return { ...out, state: "agrees", differenceCents: dNet };
  let likely: GlTieOutYear["likelyReason"] = null;
  if (input.basis === "cash") likely = "cash_basis";
  else if (Math.abs(dRev) <= tol && st.yearEndCents && !input.hasYearEndAccounts && Math.abs(dNet - st.yearEndCents) <= tol) likely = "year_end_entries";
  return { ...out, state: "differs", differenceCents: Math.abs(dNet) > tol ? dNet : dRev, likelyReason: likely };
}

/** The plain sentence for a year (broker's KPI strip and drawer; §6.6 step 5). */
export function tieOutWords(year: string, t: GlTieOutYear, accepted?: { note: string } | null): string {
  const amt = (c: number) => formatCents(Math.round(Math.abs(c) / 100) * 100, { whole: true });
  if (t.state === "agrees") return `${year}: the ledger matches the statements.`;
  if (accepted) return `${year}: the ledger differs from the statements by ${amt(t.differenceCents ?? 0)} — you accepted it: "${accepted.note}"`;
  if (t.state === "cannot_check") {
    switch (t.likelyReason) {
      case "no_statements": return `${year}: can't check yet — the analysis has no statements for ${year}.`;
      case "partial_year": return `${year}: can't check — the ledger covers only part of the year.`;
      case "unclassified_accounts": return `${year}: can't check yet — tell Cimple which of these ${t.unclassified?.length ?? 0} accounts are on the balance sheet.`;
      default: return `${year}: can't check yet.`;
    }
  }
  const which = t.revenue && Math.abs(t.revenue.ledger - t.revenue.statements) > Math.abs((t.netIncome?.ledger ?? 0) - (t.netIncome?.statements ?? 0)) ? "revenue" : "net income";
  if (t.likelyReason === "cash_basis") return `${year}: the ledger was exported on a cash basis — ask for an accrual export.`;
  if (t.likelyReason === "year_end_entries") return `${year}: the ledger's net income differs from the statements by ${amt(t.differenceCents ?? 0)} — likely the accountant's year-end entries (amortization and income taxes), which aren't in this export.`;
  return `${year}: the ledger's ${which} differs from the statements by ${amt(t.differenceCents ?? 0)} — Cimple can't tell why.`;
}

/** The KPI cell's one line: "2022–2024 match" / "2023 differs by $41,200 — likely the accountant's year-end entries". */
export function tieOutSummary(tieOut: Record<string, GlTieOutYear> | null | undefined, accepted: Record<string, unknown> = {}): { tone: "good" | "warn" | "muted"; text: string } {
  const years = Object.keys(tieOut ?? {}).sort();
  if (years.length === 0) return { tone: "muted", text: "Can't check yet — no ledger" };
  const ok = years.filter((y) => tieOut![y].state === "agrees" || (tieOut![y].state === "differs" && accepted[y]));
  const differs = years.filter((y) => tieOut![y].state === "differs" && !accepted[y]);
  const cannot = years.filter((y) => tieOut![y].state === "cannot_check");
  if (differs.length) {
    const y = differs[0];
    const t = tieOut![y];
    const amt = formatCents(Math.round(Math.abs(t.differenceCents ?? 0) / 100) * 100, { whole: true });
    return { tone: "warn", text: `${y} differs by ${amt}${t.likelyReason === "year_end_entries" ? " — likely the accountant's year-end entries" : t.likelyReason === "cash_basis" ? " — a cash-basis export" : ""}${differs.length > 1 ? ` (+${differs.length - 1} more)` : ""}` };
  }
  if (cannot.length && ok.length === 0) {
    const t = tieOut![cannot[0]];
    return { tone: "muted", text: t.likelyReason === "no_statements" ? `Can't check yet — no statements for ${yearsWords(cannot)}` : t.likelyReason === "unclassified_accounts" ? "Can't check yet — some accounts need a class" : `Can't check ${yearsWords(cannot)} yet` };
  }
  return { tone: cannot.length ? "muted" : "good", text: `${yearsWords(ok)} match${ok.length === 1 ? "es" : ""}${cannot.length ? ` · can't check ${yearsWords(cannot)}` : ""}` };
}

// ── IO: the deal's tie-out ───────────────────────────────────────────────

/** The statements the analysis the CIM uses gives, by fiscal year (cents). */
export async function statementsByYear(dealId: string): Promise<Record<string, TieOutStatements>> {
  const { storage } = await import("../storage");
  const { pickAnalysisForCim } = await import("../cim/cim-financials");
  const { normalizeFinancialAnalysisRow, computePnlNetIncome } = await import("../financial/shape");
  const { revenueByYear } = await import("../financial/normalization-rules");
  const { fiscalYearKey } = await import("@shared/fiscal-year");
  const picked = pickAnalysisForCim(await storage.getFinancialAnalysesByDeal(dealId));
  if (!picked) return {};
  const a = normalizeFinancialAnalysisRow(picked as Record<string, any>);
  const pnl = a.reclassifiedPnl as import("../financial/shape").UiReclassifiedTable | null;
  const norm = a.normalization as import("../financial/shape").UiNormalization | null;
  const rev = revenueByYear(pnl);
  const computedNet = computePnlNetIncome(pnl);
  const out: Record<string, TieOutStatements> = {};
  const labels = new Set<string>([...Object.keys(rev), ...Object.keys(norm?.netIncome ?? {}), ...Object.keys(computedNet)]);
  for (const label of Array.from(labels)) {
    const key = fiscalYearKey(label);
    if (!key) continue;
    const net = norm?.netIncome?.[label] ?? computedNet[label];
    let yearEnd = 0;
    for (const r of pnl?.rows ?? []) {
      const v = Number(r.values?.[label]);
      if (!Number.isFinite(v)) continue;
      if (r.category === "Depreciation" || r.category === "Taxes" || /amorti|depreci/i.test(r.name) || /\bincome tax/i.test(r.name)) yearEnd += v;
    }
    out[key] = {
      revenueCents: Number.isFinite(rev[label]) ? Math.round(rev[label] * 100) : null,
      netIncomeCents: Number.isFinite(Number(net)) ? Math.round(Number(net) * 100) : null,
      yearEndCents: yearEnd ? Math.round(yearEnd * 100) : null,
    };
  }
  return out;
}

const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/** The tie-out of every fiscal year the deal's ready ledgers cover (cached on gl_tracing.tie_out). */
export async function tieOutFor(dealId: string, ctx?: import("./context").GlDealContext): Promise<Record<string, GlTieOutYear>> {
  const { glStore } = await import("./store");
  const { loadGlContext } = await import("./context");
  const { fiscalYearRange } = await import("@shared/fiscal-year");
  const c = ctx ?? (await loadGlContext(dealId));
  const store = glStore();
  if (c.ready.length === 0) {
    await store.updateTracing(dealId, { tieOut: {} } as any);
    return {};
  }
  const [totals, statements] = await Promise.all([store.dealAccountTotals(dealId, Array.from(c.readyIds)), statementsByYear(dealId)]);
  const distinct = new Map(totals.map((a) => [a.accountKey, a]));
  const numberedChart = distinct.size > 0 && Array.from(distinct.values()).filter((a) => a.accountNumber).length / distinct.size >= 0.6;
  const basis = c.ready.some((l) => l.basis === "cash") ? "cash" : c.ready.some((l) => l.basis === "accrual") ? "accrual" : null;
  const out: Record<string, GlTieOutYear> = {};
  for (const y of Array.from(c.yearsAll).sort()) {
    const accounts = totals.filter((a) => a.fiscalYear === y);
    const range = fiscalYearRange(y, c.fye);
    let first: string | null = null;
    let last: string | null = null;
    for (const l of c.ready) {
      const s = (l.years as Record<string, { firstDate: string; lastDate: string }> | null)?.[y];
      if (!s) continue;
      if (!first || s.firstDate < first) first = s.firstDate;
      if (!last || s.lastDate > last) last = s.lastDate;
    }
    const months = range && first && last ? monthIndex(last < range.end ? last : range.end) - monthIndex(first > range.start ? first : range.start) + 1 : 0;
    out[y] = tieOutYear({
      accounts,
      statements: statements[y] ?? null,
      overrides: (c.tracing.accountClasses ?? {}) as Record<string, AccountClass>,
      numberedChart,
      basis,
      monthsCovered: months,
      hasYearEndAccounts: accounts.some((a) => /amorti|depreci|income tax/i.test(a.account) && a.netCents !== 0),
    });
  }
  await store.updateTracing(dealId, { tieOut: out } as any);
  return out;
}
