/**
 * demo-ledger.ts — a fictional general ledger for a DEMO deal (founder
 * question F2 / Q15; scripts/seed-demo-gl.ts). Pure.
 *
 * The ledger ties to the deal's statements year by year (revenue and net
 * income, the same figures the tie-out reads) and holds, in plainly named
 * accounts, entries that make up each approved add-back exactly:
 *   vehicle → "Automobile Expense:Vehicle – Owner" (a lease + fuel)
 *   meals   → "Meals & Entertainment" (the WHOLE cost when a share is added back)
 *   club, life insurance, settlement, consulting, anything else → its own account
 *   pay (the owner, a related party) → one payroll-provider entry per pay run
 *     on "Wages & Salaries" (no names — as real payroll looks), with a
 *     fictional T4 per person and year carrying the amount in box 14
 *   amortization / interest / income taxes → year-end journal entries
 * Everything else the statements spend is spread over ordinary accounts
 * (cost of goods sold, rent, utilities, …) so the books tie. Vendors are
 * fictional; every file says "Sample document — fictional business".
 */
import { fiscalYearRange } from "@shared/fiscal-year";
import { targetCents } from "@shared/gl-reconcile";
import { costKind, type CostKind } from "./match";

export const DEMO_SEED_TAG = "gl-demo-v1";
export const SAMPLE_LINE = "Sample document — fictional business";

export interface DemoTraceInput {
  addbackKey: string;
  label: string;
  category: string | null;
  proof: string;
  sharePct: number | null;
  /** Fiscal year → cents. */
  claims: Record<string, number>;
  /** The person paid (owner pay, related-party pay), for the T4. */
  person?: string | null;
}

export interface DemoYearInput {
  year: string;
  revenueCents: number;
  netIncomeCents: number;
}

export interface DemoLedgerRow {
  date: string;
  account: string;
  accountType: "Revenue" | "Expense" | "Cost of Goods Sold";
  name: string;
  memo: string;
  reference: string;
  debitCents: number;
  creditCents: number;
}

export interface DemoT4 {
  person: string;
  year: string;
  cents: number;
  addbackKey: string;
  text: string;
}

export interface DemoLedger {
  rows: DemoLedgerRow[];
  csv: string;
  t4s: DemoT4[];
  /** Per year: what the ledger's revenue and net income come to (they equal the statements'). */
  check: Record<string, { revenueCents: number; netIncomeCents: number; expenseCents: number }>;
  /** Years that couldn't be made to tie (the add-backs alone exceed what the statements spend). */
  problems: string[];
  planted: Array<{ addbackKey: string; year: string; account: string; entries: number; cents: number }>;
}

/** A small deterministic random sequence (same deal → same ledger). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `total` split into `n` parts that vary a little (the last one makes it exact). */
export function splitCents(total: number, n: number, rand: () => number, spread = 0.25): number[] {
  if (n <= 1 || total === 0) return [total];
  const weights = Array.from({ length: n }, () => 1 + (rand() * 2 - 1) * spread);
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.round((total * w) / sum));
  const drift = total - parts.reduce((a, b) => a + b, 0);
  parts[n - 1] += drift;
  return parts;
}

/** n dates spread over the fiscal year (monthly-ish), as yyyy-mm-dd. */
function datesIn(year: string, fye: string, n: number, rand: () => number): string[] {
  const r = fiscalYearRange(year, fye);
  if (!r) return Array.from({ length: n }, () => `${year}-06-15`);
  const start = Date.parse(`${r.start}T00:00:00Z`);
  const end = Date.parse(`${r.end}T00:00:00Z`);
  const span = end - start;
  return Array.from({ length: n }, (_, i) => {
    const t = start + Math.floor(((i + 0.2 + rand() * 0.6) / n) * span);
    return new Date(Math.min(end, Math.max(start, t))).toISOString().slice(0, 10);
  });
}

const KIND_ACCOUNT: Record<Exclude<CostKind, "pay" | "other">, { account: string; vendors: string[]; memo: string; n: number }> = {
  vehicle: { account: "Automobile Expense:Vehicle – Owner", vendors: ["Lakeview Auto Leasing", "Northline Fuel"], memo: "Owner's vehicle — lease and fuel", n: 24 },
  meals: { account: "Meals & Entertainment", vendors: ["Harbourfront Grill", "Maple Street Bistro", "Lakeside Café", "The Corner Table"], memo: "Meals", n: 30 },
  club: { account: "Dues & Memberships", vendors: ["Fairway Hills Golf Club"], memo: "Membership dues", n: 12 },
  life_insurance: { account: "Insurance:Life – Owner", vendors: ["Northern Mutual Life"], memo: "Life insurance premium (owner)", n: 12 },
  settlement: { account: "Legal & Professional Fees", vendors: ["Holloway Barristers LLP"], memo: "Settlement — former employee", n: 1 },
  consulting: { account: "Consulting Fees", vendors: ["Westbrook Systems Consulting"], memo: "Implementation project", n: 4 },
};

const STATEMENT_ACCOUNT: Array<[RegExp, string]> = [
  [/amorti|depreci/i, "Amortization Expense"],
  [/interest/i, "Interest Expense"],
  [/income tax|taxes/i, "Income Tax Expense"],
];

const SPREAD: Array<{ account: string; type: DemoLedgerRow["accountType"]; share: number; vendor: string; n: number }> = [
  { account: "Cost of Goods Sold:Materials & Parts", type: "Cost of Goods Sold", share: 0.52, vendor: "Trade Supply Co.", n: 24 },
  { account: "Subcontractors", type: "Cost of Goods Sold", share: 0.12, vendor: "Various subcontractors", n: 12 },
  { account: "Rent", type: "Expense", share: 0.08, vendor: "Commerce Park Properties", n: 12 },
  { account: "Utilities", type: "Expense", share: 0.03, vendor: "City Utilities", n: 12 },
  { account: "Repairs & Maintenance", type: "Expense", share: 0.05, vendor: "Service vans — repairs", n: 12 },
  { account: "Advertising & Marketing", type: "Expense", share: 0.06, vendor: "Local media", n: 12 },
  { account: "Office & Administration", type: "Expense", share: 0.04, vendor: "Office supplies", n: 12 },
  { account: "Insurance:Business", type: "Expense", share: 0.04, vendor: "Commercial insurer", n: 12 },
  { account: "Bank Charges & Fees", type: "Expense", share: 0.01, vendor: "Bank", n: 12 },
  { account: "Telephone & Internet", type: "Expense", share: 0.05, vendor: "Telecom", n: 12 },
];

const money = (c: number) => (c / 100).toFixed(2);
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function t4Text(input: { business: string; person: string; year: string; cents: number }): string {
  const amt = (input.cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return [
    `T4 — Statement of Remuneration Paid — ${input.year}`,
    SAMPLE_LINE,
    `Employer: ${input.business}`,
    `Employee: ${input.person}`,
    `Box 14 Employment income: ${amt}`,
    `Box 22 Income tax deducted: see payroll records`,
  ].join("\n");
}

export function buildDemoLedger(input: {
  dealId: string;
  business: string;
  fye: string;
  years: DemoYearInput[];
  traces: DemoTraceInput[];
  /** Staff wages besides the owner and related parties, as a share of revenue (default 18%). */
  staffShare?: number;
}): DemoLedger {
  const rows: DemoLedgerRow[] = [];
  const t4s: DemoT4[] = [];
  const planted: DemoLedger["planted"] = [];
  const problems: string[] = [];
  const check: DemoLedger["check"] = {};
  let ref = 1000;
  const add = (r: Omit<DemoLedgerRow, "reference">) => rows.push({ ...r, reference: String(++ref) });

  for (const y of input.years) {
    const rand = rng(`${input.dealId}:${y.year}`);
    const expenseTotal = y.revenueCents - y.netIncomeCents;
    let spent = 0;
    // Revenue: monthly sales.
    const sales = splitCents(y.revenueCents, 12, rand, 0.2);
    datesIn(y.year, input.fye, 12, rand).forEach((date, i) => add({ date, account: "Sales", accountType: "Revenue", name: "Customers — monthly sales", memo: "Sales", debitCents: 0, creditCents: sales[i] }));

    // The add-backs.
    let payCents = 0;
    for (const t of input.traces) {
      const claim = Math.round(Number(t.claims[y.year] ?? 0));
      if (!claim) continue;
      const stmt = t.proof === "statement" ? STATEMENT_ACCOUNT.find(([re]) => re.test(t.label)) : null;
      if (t.proof === "statement") {
        const account = stmt?.[1] ?? "Other Year-End Adjustments";
        add({ date: fiscalYearRange(y.year, input.fye)?.end ?? `${y.year}-12-31`, account, accountType: "Expense", name: "Year-end entry", memo: t.label, debitCents: claim, creditCents: 0 });
        spent += claim;
        planted.push({ addbackKey: t.addbackKey, year: y.year, account, entries: 1, cents: claim });
        continue;
      }
      const kind = costKind({ label: t.label, category: t.category, proof: t.proof });
      if (kind === "pay") {
        // Paid through payroll (one provider entry per run, below); a T4 shows each person's pay.
        payCents += claim;
        t4s.push({ person: t.person || "The owner", year: y.year, cents: claim, addbackKey: t.addbackKey, text: t4Text({ business: input.business, person: t.person || "The owner", year: y.year, cents: claim }) });
        continue;
      }
      const target = targetCents(claim, t.sharePct);
      const spec = kind === "other"
        ? { account: t.label.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Owner expenses", vendors: ["Various"], memo: t.label.slice(0, 80), n: 12 }
        : KIND_ACCOUNT[kind];
      const parts = splitCents(target, spec.n, rand, 0.3);
      datesIn(y.year, input.fye, spec.n, rand).forEach((date, i) => add({ date, account: spec.account, accountType: "Expense", name: spec.vendors[i % spec.vendors.length], memo: spec.memo, debitCents: parts[i], creditCents: 0 }));
      spent += target;
      planted.push({ addbackKey: t.addbackKey, year: y.year, account: spec.account, entries: spec.n, cents: target });
    }

    // Payroll: the owner and related parties plus the staff, one entry per biweekly run.
    const staff = Math.max(0, Math.round(y.revenueCents * (input.staffShare ?? 0.18)));
    let wages = payCents + staff;
    const room = expenseTotal - spent;
    if (wages > room) wages = Math.max(payCents, room);
    if (wages > room) problems.push(`${y.year}: the add-backs and pay come to more than the statements spend — the ledger can't tie this year.`);
    const runs = splitCents(wages, 26, rand, 0.05);
    datesIn(y.year, input.fye, 26, rand).forEach((date, i) => add({ date, account: "Wages & Salaries", accountType: "Expense", name: "Payroll — Wagepoint", memo: "Payroll run", debitCents: runs[i], creditCents: 0 }));
    spent += wages;

    // Everything else the statements spend, over ordinary accounts.
    const rest = expenseTotal - spent;
    if (rest < 0) {
      problems.push(`${y.year}: ${money(-rest)} more is spent in the ledger than the statements allow.`);
    } else if (rest > 0) {
      const totalShare = SPREAD.reduce((s, x) => s + x.share, 0);
      let left = rest;
      SPREAD.forEach((sp, k) => {
        const amount = k === SPREAD.length - 1 ? left : Math.round((rest * sp.share) / totalShare);
        left -= amount;
        if (amount === 0) return;
        const parts = splitCents(amount, sp.n, rand, 0.25);
        datesIn(y.year, input.fye, sp.n, rand).forEach((date, i) => add({ date, account: sp.account, accountType: sp.type, name: sp.vendor, memo: sp.account.split(":").pop()!, debitCents: parts[i], creditCents: 0 }));
      });
      spent += rest;
    }
    const yearRows = rows.filter((r) => fiscalYearRange(y.year, input.fye) && r.date >= fiscalYearRange(y.year, input.fye)!.start && r.date <= fiscalYearRange(y.year, input.fye)!.end);
    const revenue = yearRows.filter((r) => r.accountType === "Revenue").reduce((s, r) => s + r.creditCents - r.debitCents, 0);
    const expense = yearRows.filter((r) => r.accountType !== "Revenue").reduce((s, r) => s + r.debitCents - r.creditCents, 0);
    check[y.year] = { revenueCents: revenue, netIncomeCents: revenue - expense, expenseCents: expense };
  }

  rows.sort((a, b) => (a.date === b.date ? Number(a.reference) - Number(b.reference) : a.date < b.date ? -1 : 1));
  const header = ["Date", "Account", "Account Type", "Name", "Description", "Reference", "Debit", "Credit"];
  const lines = [
    csvCell(input.business),
    "General Ledger",
    csvCell(SAMPLE_LINE),
    "",
    header.join(","),
    ...rows.map((r) => [r.date, r.account, r.accountType, r.name, r.memo, r.reference, r.debitCents ? money(r.debitCents) : "", r.creditCents ? money(r.creditCents) : ""].map(csvCell).join(",")),
  ];
  return { rows, csv: lines.join("\n") + "\n", t4s, check, problems, planted };
}
