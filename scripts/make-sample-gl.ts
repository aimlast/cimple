/**
 * make-sample-gl.ts — fictional general-ledger exports for tests and local
 * screenshots (gl spec §11). Everything here is made up: "Brightwater
 * Plumbing & Heating Ltd." (fictional), its owner Dan Brightwater, spouse
 * Erin, three employees, and the vendors' entries are invented. No AI, no DB.
 *
 *   npx tsx scripts/make-sample-gl.ts                       # writes tests/fixtures/gl/*
 *   npx tsx scripts/make-sample-gl.ts --out <dir>           # somewhere else
 *   npx tsx scripts/make-sample-gl.ts --rows 200000 --out <dir>   # perf files (gl-200k.csv / .xlsx)
 *
 * The books: fiscal year = calendar year, 2022–2024. Planted add-back
 * entries: owner paycheques ("Payroll — D. Brightwater", Wages - Officers,
 * $240,000/yr), spouse pay ("Payroll — E. Brightwater", Wages & Salaries,
 * $85,000/yr), owner vehicles ("Lexus Financial" lease $1,150/mo + Petro-
 * Canada fuel in "Vehicle - Owner": $24,000 / $26,000 / $27,840), meals
 * ($18,000 / $20,000 / $22,000 whole cost), Sun Life life insurance inside
 * "Insurance" ($750/mo), golf club dues ($1,250/mo), the one-off "Holloway
 * LLP — settlement" $22,000 (Jul 15, 2024) with a $500 retainer refund, and
 * personal entries in "Shareholder Expenses" (a pharmacy, a school). The
 * accountant's 2023 year-end entries (amortization $29,700 + income tax
 * $11,500 = $41,200) are NOT in the bookkeeping file — they are in
 * adjustments.csv — so 2023's ledger differs from the statements.
 *
 * Formats written (each with its answer key in answer-key.json):
 *   qbo-classic.csv / .xlsx   QuickBooks Online, heading rows + "Total for", 2022–2024
 *   qbo-2024-only.csv         the same layout, 2024 only (overlaps the 3-year file)
 *   qbo-cash-basis.csv        QuickBooks Online, cash basis footer, 2024
 *   qbo-modern.xlsx           QuickBooks Online "Distribution account" (filled once per group), 2024
 *   qbd.csv                   QuickBooks Desktop: "6110 · Vehicle - Owner", nested, Debit/Credit, 2024
 *   xero-account-transactions.csv  Xero: heading rows "Vehicle - Owner (6110)", dd/mm/yyyy, 2024
 *   xero-gl-detail.xlsx       Xero: account column, Contact, Account Code, Account Type, date cells, 2024
 *   sage50.csv                Sage 50: Source #/JE #/Comment, Debits/Credits, page breaks, Windows-1252, 2024
 *   wave.csv                  Wave: Account Name, Amount (One column) + debit/credit, Vendor/Customer, 2024
 *   freshbooks.csv            FreshBooks: Account column, Debit/Credit, 2024
 *   account-type.csv          an export with an Account Type column, 2024
 *   payroll-provider.csv      QBO layout where payroll is one "Payroll — Wagepoint" entry per run, 2024
 *   adjustments.csv           the accountant's 2023 year-end adjusting entries
 *   odd.csv                   headings no rule knows ("When, Ledger, Who, What, In, Out") — for the AI-mapping stub
 *   bank-statement.csv, pnl.csv   not general ledgers
 *   t4-2024.txt               a T4 slip as text (box 14 $240,000)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

// ── Deterministic randomness ──────────────────────────────────────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Acct { number: string; name: string; parent?: string; type: string }
export interface Txn { date: string; acct: Acct; name: string | null; memo: string; type: string; num: string; amountCents: number }

export const COMPANY = "Brightwater Plumbing & Heating Ltd.";

const A = (number: string, name: string, type: string, parent?: string): Acct => ({ number, name, type, ...(parent ? { parent } : {}) });
export const ACCOUNTS = {
  chequing: A("1000", "Chequing", "Bank"),
  ar: A("1200", "Accounts Receivable", "Accounts Receivable"),
  vehicles: A("1500", "Vehicles", "Fixed Asset"),
  accumAmort: A("1510", "Accumulated Amortization", "Fixed Asset"),
  ap: A("2000", "Accounts Payable", "Accounts Payable"),
  hst: A("2100", "HST Payable", "Other Current Liability"),
  payrollLiab: A("2200", "Payroll Liabilities", "Other Current Liability"),
  shareholderLoan: A("2500", "Shareholder Loan", "Long Term Liability"),
  service: A("4000", "Sales - Service", "Income"),
  installs: A("4010", "Sales - Installations", "Income"),
  materials: A("5000", "Materials & Supplies", "Cost of Goods Sold"),
  subs: A("5100", "Subcontractors", "Cost of Goods Sold"),
  wages: A("6000", "Wages & Salaries", "Expense"),
  officers: A("6010", "Wages - Officers", "Expense"),
  cppEi: A("6020", "Payroll Taxes - CPP/EI", "Expense"),
  wsib: A("6030", "WSIB", "Expense"),
  benefits: A("6040", "Employee Benefits", "Expense"),
  auto: A("6100", "Automobile Expense", "Expense"),
  vehicleOwner: A("6110", "Vehicle - Owner", "Expense", "Automobile Expense"),
  fuelVans: A("6120", "Fuel - Service Vans", "Expense", "Automobile Expense"),
  vanRepairs: A("6130", "Van Repairs & Maintenance", "Expense", "Automobile Expense"),
  meals: A("6200", "Meals and Entertainment", "Expense"),
  insurance: A("6300", "Insurance", "Expense"),
  legal: A("6400", "Legal & Professional Fees", "Expense"),
  rent: A("6500", "Rent", "Expense"),
  utilities: A("6510", "Utilities", "Expense"),
  phone: A("6520", "Telephone & Internet", "Expense"),
  advertising: A("6600", "Advertising & Promotion", "Expense"),
  office: A("6700", "Office Supplies", "Expense"),
  software: A("6710", "Software & Subscriptions", "Expense"),
  bankCharges: A("6800", "Bank Charges", "Expense"),
  interest: A("6810", "Interest Expense", "Expense"),
  dues: A("6900", "Dues & Memberships", "Expense"),
  shareholderExp: A("6910", "Shareholder Expenses", "Expense"),
  donations: A("6920", "Donations", "Expense"),
  repairs: A("6950", "Repairs & Maintenance", "Expense"),
  amortization: A("7000", "Amortization Expense", "Expense"),
  incomeTax: A("7100", "Income Tax Expense", "Other Expense"),
};

const CUSTOMERS = ["Halton Property Group", "Maple Ridge Condos", "J. Alvarez", "Lakeview Dental Centre", "Northgate Schools", "P. Nguyen", "Oakville Medical Arts", "Riverstone Homes", "S. Kowalski", "Bayfront Hotel"];
const EMPLOYEES = [
  { name: "M. Chen", perRun: 2615.38 },
  { name: "J. Okafor", perRun: 2423.08 },
  { name: "R. Singh", perRun: 2192.31 },
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const cents = (dollars: number) => Math.round(dollars * 100);

/** Spreads `total` cents over `n` parts of about the same size (deterministic), last one absorbs rounding. */
function spread(total: number, n: number, rnd: () => number, jitter = 0.25): number[] {
  const weights = Array.from({ length: n }, () => 1 - jitter + rnd() * 2 * jitter);
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.round((total * w) / sum));
  parts[n - 1] += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

/** Biweekly Friday pay dates of a year (from the first Friday on or after Jan 7). */
function biweekly(year: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(year, 0, 7));
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCFullYear() === year && out.length < 26) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 14);
  }
  while (out.length < 26) out.push(iso(year, 12, 31));
  return out;
}

const VEHICLE_OWNER: Record<number, number> = { 2022: 2_400_000, 2023: 2_600_000, 2024: 2_784_000 };
const MEALS: Record<number, number> = { 2022: 1_800_000, 2023: 2_000_000, 2024: 2_200_000 };
const AMORT: Record<number, number> = { 2022: 2_800_000, 2023: 2_970_000, 2024: 3_100_000 };
const TAX: Record<number, number> = { 2022: 980_000, 2023: 1_150_000, 2024: 1_420_000 };

/**
 * Every bookkeeping entry of the fictional books for `years` (P&L side, plus
 * monthly bank summaries, quarterly HST and the year-end entries — 2023's
 * year-end entries only when `withAdjustments2023`).
 */
export function makeBooks(years: number[], opts: { payrollProvider?: boolean; withAdjustments2023?: boolean } = {}): Txn[] {
  const rnd = mulberry32(20241009);
  const out: Txn[] = [];
  let num = 1000;
  const add = (date: string, acct: Acct, name: string | null, memo: string, type: string, amountCents: number) => {
    out.push({ date, acct, name, memo, type, num: String(++num), amountCents });
  };
  for (const y of years) {
    let revenue = 0;
    let spend = 0;
    for (let m = 1; m <= 12; m++) {
      // Revenue (credits → negative amounts).
      for (let i = 0; i < 8; i++) {
        const c = cents(1200 + Math.floor(rnd() * 7800));
        add(iso(y, m, 2 + i * 3), ACCOUNTS.service, CUSTOMERS[(m + i) % CUSTOMERS.length], `Service call ${y}-${pad(m)}-${i + 1}`, "Invoice", -c);
        revenue += c;
      }
      for (let i = 0; i < 3; i++) {
        const c = cents(8000 + Math.floor(rnd() * 22000));
        add(iso(y, m, 5 + i * 8), ACCOUNTS.installs, CUSTOMERS[(m * 3 + i) % CUSTOMERS.length], `Furnace / boiler installation`, "Invoice", -c);
        revenue += c;
      }
      // Materials and subcontractors.
      for (let i = 0; i < 5; i++) {
        const c = cents(400 + Math.floor(rnd() * 5200));
        add(iso(y, m, 3 + i * 5), ACCOUNTS.materials, ["Wolseley Canada", "Emco Supply", "The Home Depot"][i % 3], "Pipe, fittings and parts", "Bill", c);
        spend += c;
      }
      for (let i = 0; i < 2; i++) {
        const c = cents(2500 + Math.floor(rnd() * 6500));
        add(iso(y, m, 10 + i * 9), ACCOUNTS.subs, ["Delta Electrical", "Precision Ductwork"][i], "Subcontract work", "Bill", c);
        spend += c;
      }
      // Fixed monthly costs.
      const monthly: Array<[Acct, string | null, string, number]> = [
        [ACCOUNTS.rent, "Brightwater Holdings Inc.", "Shop rent", 450000],
        [ACCOUNTS.utilities, "Enbridge Gas", "Gas", cents(180 + rnd() * 220)],
        [ACCOUNTS.utilities, "Toronto Hydro", "Hydro", cents(210 + rnd() * 160)],
        [ACCOUNTS.phone, "Bell Canada", "Phones", cents(310 + rnd() * 40)],
        [ACCOUNTS.phone, "Rogers", "Internet", 12995],
        [ACCOUNTS.advertising, "Google Ads", "Search ads", cents(900 + rnd() * 700)],
        [ACCOUNTS.office, "Staples", "Office supplies", cents(60 + rnd() * 240)],
        [ACCOUNTS.software, "Intuit QuickBooks", "QuickBooks Online", 9000],
        [ACCOUNTS.software, "Jobber", "Field service software", 24900],
        [ACCOUNTS.bankCharges, "RBC Royal Bank", "Monthly fee", 2995],
        [ACCOUNTS.interest, "RBC Royal Bank", "Loan interest", cents(610 - m * 8)],
        [ACCOUNTS.cppEi, "Receiver General", "CPP/EI remittance", cents(3100 + rnd() * 300)],
        [ACCOUNTS.benefits, "Manulife", "Group benefits", 112000],
        [ACCOUNTS.legal, "Ledgerline Bookkeeping", "Monthly bookkeeping", 45000],
        [ACCOUNTS.insurance, "Sun Life", "Life insurance premium - D. Brightwater", 75000],
        [ACCOUNTS.dues, "Glen Abbey Golf Club", "Membership dues", 125000],
      ];
      for (const [acct, name, memo, c] of monthly) {
        add(iso(y, m, 1 + (acct.number.charCodeAt(2) % 20)), acct, name, memo, "Expense", c);
        spend += c;
      }
      // Van fuel weekly.
      for (let w = 0; w < 4; w++) {
        const c = cents(140 + rnd() * 120);
        add(iso(y, m, 3 + w * 7), ACCOUNTS.fuelVans, w % 2 ? "Esso" : "Petro-Canada", "Fuel - service vans", "Expense", c);
        spend += c;
      }
      if (m % 3 === 0) {
        add(iso(y, m, 15), ACCOUNTS.wsib, "WSIB", "Quarterly premium", "Expense", 210000);
        add(iso(y, m, 20), ACCOUNTS.insurance, "Intact Insurance", "Business insurance - quarterly", "Expense", 300000);
        add(iso(y, m, 22), ACCOUNTS.vanRepairs, "Midas", "Van service", "Expense", cents(300 + rnd() * 500));
        spend += 210000 + 300000;
      }
      if (m === 6) add(iso(y, m, 18), ACCOUNTS.repairs, "Rapid Roofing", "Shop roof repair", "Expense", cents(1800 + rnd() * 900));
    }
    // Payroll.
    const runs = biweekly(y);
    if (opts.payrollProvider) {
      const employeeRun = EMPLOYEES.reduce((a, e) => a + cents(e.perRun), 0);
      const spouseRuns = spread(8_500_000, 26, () => 0.5, 0);
      runs.forEach((d, i) => add(d, ACCOUNTS.wages, "Wagepoint", `Pay run ${d}`, "Payroll", employeeRun + spouseRuns[i] + 923077));
    } else {
      for (const e of EMPLOYEES) for (const d of runs) add(d, ACCOUNTS.wages, `Payroll — ${e.name}`, "Biweekly pay", "Paycheque", cents(e.perRun));
      const spouse = spread(8_500_000, 26, () => 0.5, 0);
      runs.forEach((d, i) => add(d, ACCOUNTS.wages, "Payroll — E. Brightwater", "Biweekly pay", "Paycheque", spouse[i]));
      for (let m = 1; m <= 12; m++) {
        add(iso(y, m, 15), ACCOUNTS.officers, "Payroll — D. Brightwater", "Semi-monthly salary", "Paycheque", 1_000_000);
        add(iso(y, m, 28), ACCOUNTS.officers, "Payroll — D. Brightwater", "Semi-monthly salary", "Paycheque", 1_000_000);
      }
    }
    // Owner vehicle: lease + fuel + insurance, exactly the year's total.
    const lease = 12 * 115000;
    const insuranceOwner = 186000;
    const fuel = spread(VEHICLE_OWNER[y] - lease - insuranceOwner, 24, rnd, 0.3);
    for (let m = 1; m <= 12; m++) add(iso(y, m, 3), ACCOUNTS.vehicleOwner, "Lexus Financial", `Lease ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} - Lexus RX`, "Expense", 115000);
    fuel.forEach((c, i) => add(iso(y, 1 + Math.floor(i / 2), i % 2 ? 24 : 11), ACCOUNTS.vehicleOwner, "Petro-Canada", "Fuel - Lexus RX", "Expense", c));
    add(iso(y, 4, 2), ACCOUNTS.vehicleOwner, "Intact Insurance", "Auto insurance - Lexus RX", "Expense", insuranceOwner);
    // Meals, whole cost.
    const meals = spread(MEALS[y], 36, rnd, 0.6);
    const places = ["The Keg", "Tim Hortons", "Earls Kitchen", "Café Novo", "Jack Astor's"];
    meals.forEach((c, i) => add(iso(y, 1 + Math.floor(i / 3), 6 + (i % 3) * 8), ACCOUNTS.meals, places[i % places.length], i % 4 === 0 ? "Client dinner" : "Team lunch", "Credit Card", c));
    // Yearly items.
    add(iso(y, 3, 30), ACCOUNTS.legal, "Moore & Partners CPA", "Year-end financial statements", "Bill", 650000);
    add(iso(y, 2, 1), ACCOUNTS.dues, "HRAI", "Association membership", "Expense", 65000);
    add(iso(y, 11, 20), ACCOUNTS.donations, "SickKids Foundation", "Donation", "Expense", 100000);
    if (y === 2024) {
      add("2024-07-15", ACCOUNTS.legal, "Holloway LLP", "Settlement - wrongful dismissal", "Bill Payment", 2_200_000);
      add("2024-07-31", ACCOUNTS.legal, "Holloway LLP", "Refund of retainer", "General Journal", -50000);
      add("2024-05-02", ACCOUNTS.shareholderExp, "Shoppers Drug Mart", "Prescription", "Expense", 6420);
      add("2024-09-05", ACCOUNTS.shareholderExp, "Upper Canada College", "Tuition - fall term", "Expense", 950000);
    }
    if (y === 2023) add("2023-08-14", ACCOUNTS.shareholderExp, "Rexall", "Pharmacy", "Expense", 3815);
    // Year-end entries (not in the bookkeeping file for 2023 unless asked).
    if (y !== 2023 || opts.withAdjustments2023) {
      add(iso(y, 12, 31), ACCOUNTS.amortization, null, "Year-end amortization", "Journal Entry", AMORT[y]);
      add(iso(y, 12, 31), ACCOUNTS.accumAmort, null, "Year-end amortization", "Journal Entry", -AMORT[y]);
      add(iso(y, 12, 31), ACCOUNTS.incomeTax, null, "Current income taxes", "Journal Entry", TAX[y]);
    }
    // Balance-sheet side: monthly bank summaries, quarterly HST, a shareholder loan advance.
    for (let m = 1; m <= 12; m++) {
      add(iso(y, m, 28), ACCOUNTS.chequing, null, "Deposits - month", "Deposit", Math.round(revenue / 12));
      add(iso(y, m, 28), ACCOUNTS.chequing, null, "Payments - month", "Payment", -Math.round(spend / 12));
      if (m % 3 === 0) add(iso(y, m, 30), ACCOUNTS.hst, "Receiver General", "HST remittance", "Payment", cents(9800 + rnd() * 900));
    }
    add(iso(y, 6, 1), ACCOUNTS.shareholderLoan, "Dan Brightwater", "Shareholder advance", "Journal Entry", -1_000_000);
  }
  return out.sort((a, b) => (a.acct.number + a.date + a.num).localeCompare(b.acct.number + b.date + b.num));
}

/** The accountant's 2023 year-end adjusting entries (not in the bookkeeping file). */
export function makeAdjustments(): Txn[] {
  return [
    { date: "2023-12-31", acct: ACCOUNTS.amortization, name: null, memo: "AJE 1 - Year-end amortization", type: "Journal Entry", num: "AJE1", amountCents: AMORT[2023] },
    { date: "2023-12-31", acct: ACCOUNTS.accumAmort, name: null, memo: "AJE 1 - Year-end amortization", type: "Journal Entry", num: "AJE1", amountCents: -AMORT[2023] },
    { date: "2023-12-31", acct: ACCOUNTS.incomeTax, name: null, memo: "AJE 2 - Current income taxes", type: "Journal Entry", num: "AJE2", amountCents: TAX[2023] },
    { date: "2023-12-31", acct: ACCOUNTS.hst, name: null, memo: "AJE 2 - Taxes payable", type: "Journal Entry", num: "AJE2", amountCents: -TAX[2023] },
  ];
}

// ── Rendering ─────────────────────────────────────────────────────────────

const money = (c: number) => (c / 100).toFixed(2);
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: unknown[][], eol = "\n") => rows.map((r) => r.map(csvCell).join(",")).join(eol) + eol;
const mdy = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const full = (a: Acct) => (a.parent ? `${a.parent}:${a.name}` : a.name);

function byAccount(txns: Txn[]): Array<[Acct, Txn[]]> {
  const map = new Map<string, [Acct, Txn[]]>();
  for (const t of txns) {
    const k = t.acct.number;
    if (!map.has(k)) map.set(k, [t.acct, []]);
    map.get(k)![1].push(t);
  }
  return Array.from(map.values()).sort((a, b) => a[0].number.localeCompare(b[0].number));
}

function split(t: Txn): string {
  return t.acct.type === "Bank" ? "-Split-" : "Chequing";
}

/** QuickBooks Online "General Ledger" (classic): heading rows, sub-accounts indented, "Total for", footer. */
export function renderQboClassic(txns: Txn[], period: string, basis: "Accrual" | "Cash" = "Accrual"): unknown[][] {
  const rows: unknown[][] = [[COMPANY], ["General Ledger"], [period], [], ["", "Date", "Transaction Type", "Num", "Name", "Memo/Description", "Split", "Amount", "Balance"]];
  let openParent: string | null = null;
  const groups = byAccount(txns);
  groups.forEach(([acct, list], gi) => {
    if (acct.parent && openParent !== acct.parent) {
      rows.push([acct.parent]);
      openParent = acct.parent;
    } else if (!acct.parent && openParent) {
      rows.push([`Total for ${openParent}`, "", "", "", "", "", "", "", ""]);
      openParent = null;
    }
    rows.push([acct.parent ? `   ${acct.name}` : acct.name]);
    if (/Bank|Liability|Asset|Payable|Receivable/.test(acct.type)) rows.push(["", "", "", "", "", "Beginning Balance", "", "", "0.00"]);
    let bal = 0;
    for (const t of list) {
      bal += t.amountCents;
      rows.push(["", mdy(t.date), t.type, t.num, t.name ?? "", t.memo, split(t), money(t.amountCents), money(bal)]);
    }
    rows.push([acct.parent ? `   Total for ${acct.name}` : `Total for ${acct.name}`, "", "", "", "", "", "", money(bal), ""]);
    const next = groups[gi + 1]?.[0];
    if (acct.parent && (!next || next.parent !== acct.parent)) {
      rows.push([`Total for ${acct.parent}`, "", "", "", "", "", "", "", ""]);
      openParent = null;
    }
  });
  rows.push([], ["TOTAL", "", "", "", "", "", "", "", ""], [], [`${basis} Basis Thursday, January 9, 2025 10:12 AM GMT-05:00`]);
  return rows;
}

/** QuickBooks Online newer export: "Distribution account" column, the account on its own row above each group. */
export function renderQboModern(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [[COMPANY], ["General Ledger"], ["January 1-December 31, 2024"], [],
    ["Distribution account", "Transaction date", "Transaction type", "Num", "Name", "Memo/Description", "Split account", "Amount", "Balance"]];
  for (const [acct, list] of byAccount(txns)) {
    rows.push([full(acct)]);
    let bal = 0;
    for (const t of list) {
      bal += t.amountCents;
      rows.push(["", { date: t.date }, t.type, t.num, t.name ?? "", t.memo, split(t), t.amountCents / 100, bal / 100]);
    }
    rows.push([`Total for ${full(acct)}`, "", "", "", "", "", "", bal / 100, ""]);
  }
  rows.push([], [], ["Accrual basis Thursday, January 9, 2025 10:15 AM GMT-05:00"]);
  return rows;
}

/** QuickBooks Desktop: "6110 · Vehicle - Owner" headings nested by column, Debit/Credit, "Total 6110 · …". */
export function renderQbd(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [["Accrual Basis Thursday, January 9, 2025 10:12 AM GMT-05:00", "", "Type", "Date", "Num", "Adj", "Name", "Memo", "Split", "Debit", "Credit", "Balance"]];
  const parentNum = (name: string) => Object.values(ACCOUNTS).find((a) => a.name === name)?.number ?? "6100";
  const groups = byAccount(txns);
  let open: string | null = null;
  groups.forEach(([acct, list], gi) => {
    const label = `${acct.number} · ${acct.name}`;
    if (acct.parent && open !== acct.parent) {
      rows.push([`${parentNum(acct.parent)} · ${acct.parent}`]);
      open = acct.parent;
    }
    const depth = acct.parent ? 1 : 0;
    rows.push([...Array(depth).fill(""), label]);
    let bal = 0;
    for (const t of list) {
      bal += t.amountCents;
      const debit = t.amountCents >= 0 ? money(t.amountCents) : "";
      // Credits as "(500.00)" now and then — still a credit.
      const credit = t.amountCents < 0 ? (Number(t.num) % 5 === 0 ? `(${money(-t.amountCents)})` : money(-t.amountCents)) : "";
      rows.push(["", "", t.type, mdy(t.date), t.num, "", t.name ?? "", t.memo, split(t), debit === "" ? "" : Number(debit) >= 1000 ? Number(debit).toLocaleString("en-US", { minimumFractionDigits: 2 }) : debit, credit, money(bal)]);
    }
    rows.push([...Array(depth).fill(""), `Total ${label}`, ...Array(8 - depth).fill(""), money(Math.max(bal, 0)), money(Math.max(-bal, 0)), ""]);
    const next = groups[gi + 1]?.[0];
    if (acct.parent && (!next || next.parent !== acct.parent)) {
      rows.push([`Total ${parentNum(acct.parent)} · ${acct.parent}`]);
      open = null;
    }
  });
  rows.push(["TOTAL"]);
  return rows;
}

/** Xero "Account Transactions": headings "Vehicle - Owner (6110)", dd/mm/yyyy, Opening/Closing balance rows. */
export function renderXeroAccountTransactions(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [["Account Transactions"], [COMPANY], ["For the period 1 January 2024 to 31 December 2024"], [],
    ["Date", "Source", "Description", "Reference", "Debit", "Credit", "Running Balance"]];
  for (const [acct, list] of byAccount(txns)) {
    rows.push([`${full(acct)} (${acct.number})`]);
    rows.push(["", "", "Opening Balance", "", "", "", "0.00"]);
    let bal = 0;
    for (const t of list) {
      bal += t.amountCents;
      rows.push([dmy(t.date), t.type === "Invoice" ? "Receivable Invoice" : t.type === "Bill" ? "Payable Invoice" : "Spend Money", [t.name, t.memo].filter(Boolean).join(" - "), t.num, t.amountCents >= 0 ? money(t.amountCents) : "", t.amountCents < 0 ? money(-t.amountCents) : "", money(bal)]);
    }
    rows.push([`Total ${full(acct)} (${acct.number})`, "", "", "", "", "", money(bal)]);
    rows.push(["", "", "Closing Balance", "", "", "", money(bal)]);
  }
  return rows;
}

const XERO_TYPE: Record<string, string> = {
  Bank: "Bank", "Accounts Receivable": "Current Asset", "Fixed Asset": "Fixed Asset", "Accounts Payable": "Current Liability",
  "Other Current Liability": "Current Liability", "Long Term Liability": "Non-current Liability", Income: "Revenue",
  "Cost of Goods Sold": "Direct Costs", Expense: "Expense", "Other Expense": "Expense",
};

/** Xero "General Ledger Detail": one row per entry, account column, Account Code/Type, Contact, date cells. */
export function renderXeroGlDetail(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [["General Ledger Detail"], [COMPANY], ["1 January 2024 to 31 December 2024"], [],
    ["Date", "Account Code", "Account", "Account Type", "Contact", "Description", "Reference", "Debit", "Credit", "Gross", "GST"]];
  for (const t of txns.slice().sort((a, b) => (a.date + a.num).localeCompare(b.date + b.num))) {
    rows.push([{ date: t.date }, t.acct.number, full(t.acct), XERO_TYPE[t.acct.type] ?? "Expense", t.name ?? "", t.memo, t.num,
      t.amountCents >= 0 ? t.amountCents / 100 : null, t.amountCents < 0 ? -t.amountCents / 100 : null, t.amountCents / 100, 0]);
  }
  return rows;
}

/** Sage 50 "General Ledger Report": "5300 Advertising…" headings, Source #/JE #, Debits/Credits, page breaks. */
export function renderSage50(txns: Txn[]): unknown[][] {
  const title: unknown[][] = [[COMPANY], ["General Ledger Report"], ["01/01/2024 to 12/31/2024"]];
  const header = ["Date", "Comment", "Source #", "JE #", "Debits", "Credits", "Balance"];
  const rows: unknown[][] = [...title, header];
  let onPage = 0;
  let page = 1;
  const pageBreak = () => {
    page++;
    rows.push([], [`Page ${page}`], ...title, header);
    onPage = 0;
  };
  for (const [acct, list] of byAccount(txns)) {
    rows.push([`${acct.number} ${acct.name}`]);
    let bal = 0;
    for (const t of list) {
      if (++onPage > 45) pageBreak();
      bal += t.amountCents;
      rows.push([mdy(t.date), [t.name, t.memo].filter(Boolean).join(", "), t.num, `J${t.num}`, t.amountCents >= 0 ? money(t.amountCents) : "", t.amountCents < 0 ? money(-t.amountCents) : "", money(bal)]);
    }
  }
  rows.push([], ["Generated On: 01/09/2025 10:12:33 AM"]);
  return rows;
}

/** Wave "Account Transactions (General Ledger)" export: flat, Account Name, one-column and two-column amounts. */
export function renderWave(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [["Transaction ID", "Transaction Date", "Account Name", "Transaction Description", "Transaction Line Description", "Amount (One column)", "Debit Amount (Two Column Approach)", "Credit Amount (Two Column Approach)", "Other Accounts for this Transaction", "Customer", "Vendor", "Invoice Number", "Bill Number", "Notes / Memo", "Amount Before Sales Tax", "Sales Tax Amount", "Sales Tax Name", "Transaction Date Added", "Transaction Date Last Modified", "Account Group", "Account Type", "Account ID"]];
  for (const t of txns.slice().sort((a, b) => (a.date + a.num).localeCompare(b.date + b.num))) {
    const income = t.acct.type === "Income";
    rows.push([t.num, t.date, full(t.acct), t.memo, "", money(t.amountCents), t.amountCents >= 0 ? money(t.amountCents) : "", t.amountCents < 0 ? money(-t.amountCents) : "", "Chequing", income ? t.name ?? "" : "", income ? "" : t.name ?? "", income ? t.num : "", income ? "" : t.num, "", money(t.amountCents), "", "", t.date, t.date, /Income/.test(t.acct.type) ? "Income" : /Expense|Cost/.test(t.acct.type) ? "Expense" : "Asset", t.acct.type, `A${t.acct.number}`]);
  }
  return rows;
}

/** FreshBooks "General Ledger": title rows, an Account column on every row, Debit/Credit. */
export function renderFreshBooks(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [["FreshBooks"], ["General Ledger"], [COMPANY], ["Jan 1, 2024 - Dec 31, 2024"], [],
    ["Account", "Date", "Description", "Debit", "Credit", "Balance"]];
  for (const [acct, list] of byAccount(txns)) {
    let bal = 0;
    for (const t of list) {
      bal += t.amountCents;
      rows.push([`${acct.name} (${acct.number})`, `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+t.date.slice(5, 7) - 1]} ${+t.date.slice(8, 10)}, ${t.date.slice(0, 4)}`, [t.name, t.memo].filter(Boolean).join(" — "), t.amountCents >= 0 ? money(t.amountCents) : "", t.amountCents < 0 ? money(-t.amountCents) : "", money(bal)]);
    }
  }
  return rows;
}

/** A plain export with an Account Type column. */
export function renderAccountType(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [["Date", "Account", "Account Type", "Name", "Description", "Debit", "Credit"]];
  for (const t of txns.slice().sort((a, b) => (a.date + a.num).localeCompare(b.date + b.num))) {
    rows.push([t.date, `${t.acct.number} ${full(t.acct)}`, XERO_TYPE[t.acct.type] ?? t.acct.type, t.name ?? "", t.memo, t.amountCents >= 0 ? money(t.amountCents) : "", t.amountCents < 0 ? money(-t.amountCents) : ""]);
  }
  return rows;
}

/** Headings no rule recognises — only the AI mapping (or the broker) can read it. */
export function renderOdd(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [["When", "Ledger", "Who", "What", "In", "Out"]];
  for (const t of txns.slice(0, 400)) rows.push([mdy(t.date), full(t.acct), t.name ?? "", t.memo, t.amountCents < 0 ? money(-t.amountCents) : "", t.amountCents >= 0 ? money(t.amountCents) : ""]);
  return rows;
}

function renderAdjustments(txns: Txn[]): unknown[][] {
  const rows: unknown[][] = [["Moore & Partners CPA"], ["Adjusting Journal Entries - year ended December 31, 2023"], [], ["Date", "Account", "Description", "Debit", "Credit"]];
  for (const t of txns) rows.push([mdy(t.date), `${t.acct.number} ${t.acct.name}`, t.memo, t.amountCents >= 0 ? money(t.amountCents) : "", t.amountCents < 0 ? money(-t.amountCents) : ""]);
  return rows;
}

/** Windows-1252 bytes (the few non-ASCII characters the fixtures use). */
function win1252(text: string): Buffer {
  const map: Record<string, number> = { "é": 0xe9, "è": 0xe8, "à": 0xe0, "ô": 0xf4, "—": 0x97, "’": 0x92, "–": 0x96 };
  const bytes: number[] = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) bytes.push(c);
    else bytes.push(map[ch] ?? 0x3f);
  }
  return Buffer.from(bytes);
}

const SERIAL0 = Date.UTC(1899, 11, 30);
function toSheet(rows: unknown[][], dateFormat = "mm/dd/yyyy"): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((c) => (c && typeof c === "object" && "date" in (c as object) ? null : c))));
  rows.forEach((r, R) => r.forEach((c, C) => {
    if (c && typeof c === "object" && "date" in (c as object)) {
      const d = (c as { date: string }).date;
      const serial = (Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - SERIAL0) / 86400000;
      ws[XLSX.utils.encode_cell({ r: R, c: C })] = { t: "n", v: serial, z: dateFormat };
    }
  }));
  return ws;
}

function writeXlsx(file: string, rows: unknown[][], sheet = "General Ledger", dateFormat?: string): void {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, toSheet(rows, dateFormat), sheet);
  fs.writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }));
}

/** Per-year, per-account totals (by the account path the parser should produce) — the answer key. */
function totals(txns: Txn[], accountOf: (a: Acct) => string): { entries: number; byYear: Record<string, number>; accounts: Record<string, Record<string, number>> } {
  const byYear: Record<string, number> = {};
  const accounts: Record<string, Record<string, number>> = {};
  for (const t of txns) {
    const y = t.date.slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + 1;
    const k = accountOf(t.acct);
    accounts[k] = accounts[k] ?? {};
    accounts[k][y] = (accounts[k][y] ?? 0) + t.amountCents;
  }
  return { entries: txns.length, byYear, accounts };
}

/** The statements' figures (what the financial analysis would show) for the tie-out tests. */
function statements(txns: Txn[]): Record<string, { revenue: number; netIncome: number; amortization: number; incomeTax: number }> {
  const out: Record<string, { revenue: number; netIncome: number; amortization: number; incomeTax: number }> = {};
  for (const t of txns) {
    const y = t.date.slice(0, 4);
    out[y] = out[y] ?? { revenue: 0, netIncome: 0, amortization: 0, incomeTax: 0 };
    if (t.acct.type === "Income") { out[y].revenue -= t.amountCents; out[y].netIncome -= t.amountCents; }
    else if (/Expense|Cost/.test(t.acct.type)) {
      out[y].netIncome -= t.amountCents;
      if (t.acct === ACCOUNTS.amortization) out[y].amortization += t.amountCents;
      if (t.acct === ACCOUNTS.incomeTax) out[y].incomeTax += t.amountCents;
    }
  }
  return out;
}

export function writeFixtures(outDir: string): Record<string, unknown> {
  fs.mkdirSync(outDir, { recursive: true });
  const books3 = makeBooks([2022, 2023, 2024]);
  const books24 = books3.filter((t) => t.date.startsWith("2024"));
  const payroll24 = makeBooks([2024], { payrollProvider: true });
  const adj = makeAdjustments();
  const key: Record<string, unknown> = {};
  const path3 = (a: Acct) => full(a);
  const write = (name: string, body: string | Buffer) => fs.writeFileSync(path.join(outDir, name), body);

  write("qbo-classic.csv", toCsv(renderQboClassic(books3, "January 1, 2022 - December 31, 2024")));
  writeXlsx(path.join(outDir, "qbo-classic.xlsx"), renderQboClassic(books3, "January 1, 2022 - December 31, 2024").map((r) =>
    r.map((c, i) => (i === 1 && typeof c === "string" && /^\d{2}\/\d{2}\/\d{4}$/.test(c) ? { date: `${c.slice(6)}-${c.slice(0, 2)}-${c.slice(3, 5)}` } : (i === 7 || i === 8) && typeof c === "string" && /^-?\d+\.\d{2}$/.test(c) ? Number(c) : c))));
  key["qbo-classic"] = { software: "quickbooks_online", basis: "accrual", accountMode: "heading_rows", amountMode: "single", dateOrder: "mdy", ...totals(books3, path3) };
  key["qbo-classic-xlsx"] = key["qbo-classic"];

  write("qbo-2024-only.csv", toCsv(renderQboClassic(books24, "January 1 - December 31, 2024")));
  key["qbo-2024-only"] = { software: "quickbooks_online", basis: "accrual", accountMode: "heading_rows", ...totals(books24, path3) };
  write("qbo-cash-basis.csv", toCsv(renderQboClassic(books24, "January 1 - December 31, 2024", "Cash")));
  key["qbo-cash-basis"] = { software: "quickbooks_online", basis: "cash", accountMode: "heading_rows", ...totals(books24, path3) };

  writeXlsx(path.join(outDir, "qbo-modern.xlsx"), renderQboModern(books24));
  key["qbo-modern"] = { software: "quickbooks_online", basis: "accrual", accountMode: "column_fill_down", amountMode: "single", ...totals(books24, path3) };

  write("qbd.csv", toCsv(renderQbd(books24), "\r\n"));
  key["qbd"] = { software: "quickbooks_desktop", basis: "accrual", accountMode: "heading_rows", amountMode: "debit_credit", dateOrder: "mdy", ...totals(books24, path3) };

  write("xero-account-transactions.csv", toCsv(renderXeroAccountTransactions(books24)));
  key["xero-account-transactions"] = { software: "xero", accountMode: "heading_rows", amountMode: "debit_credit", dateOrder: "dmy", ...totals(books24, path3) };

  writeXlsx(path.join(outDir, "xero-gl-detail.xlsx"), renderXeroGlDetail(books24), "General Ledger Detail", "d mmm yyyy");
  key["xero-gl-detail"] = { software: "xero", accountMode: "column", amountMode: "debit_credit", ...totals(books24, path3) };

  write("sage50.csv", win1252(toCsv(renderSage50(books24), "\r\n")));
  key["sage50"] = { software: "sage50", accountMode: "heading_rows", amountMode: "debit_credit", dateOrder: "mdy", encoding: "windows-1252", ...totals(books24, (a) => a.name) };

  write("wave.csv", toCsv(renderWave(books24)));
  key["wave"] = { software: "wave", accountMode: "column", amountMode: "debit_credit", dateOrder: "ymd", ...totals(books24, path3) };

  write("freshbooks.csv", toCsv(renderFreshBooks(books24)));
  key["freshbooks"] = { software: "freshbooks", accountMode: "column", amountMode: "debit_credit", ...totals(books24, (a) => a.name) };

  write("account-type.csv", toCsv(renderAccountType(books24)));
  key["account-type"] = { accountMode: "column", amountMode: "debit_credit", dateOrder: "ymd", ...totals(books24, path3) };

  write("payroll-provider.csv", toCsv(renderQboClassic(payroll24, "January 1 - December 31, 2024")));
  key["payroll-provider"] = { software: "quickbooks_online", accountMode: "heading_rows", ...totals(payroll24, path3) };

  write("adjustments.csv", toCsv(renderAdjustments(adj)));
  key["adjustments"] = { accountMode: "column", amountMode: "debit_credit", ...totals(adj, (a) => a.name) };

  write("odd.csv", toCsv(renderOdd(books24)));
  key["odd"] = { detectable: false };

  write("bank-statement.csv", toCsv([["Date", "Description", "Withdrawals", "Deposits", "Balance"],
    ...books24.filter((t) => t.acct.type !== "Bank").slice(0, 120).map((t, i) => [t.date, (t.name ?? t.memo).toUpperCase(), t.amountCents >= 0 ? money(t.amountCents) : "", t.amountCents < 0 ? money(-t.amountCents) : "", money(500000 + i * 1000)])]));
  write("bank-statement-amount.csv", toCsv([["Date", "Description", "Amount", "Balance"],
    ...books24.filter((t) => t.acct.type !== "Bank").slice(0, 120).map((t, i) => [mdy(t.date), (t.name ?? t.memo).toUpperCase(), money(-t.amountCents), money(500000 + i * 1000)])]));
  write("pnl.csv", toCsv([[COMPANY], ["Profit and Loss"], ["January - December 2024"], [], ["", "Total"],
    ...byAccount(books24).filter(([a]) => /Income|Expense|Cost/.test(a.type)).map(([a, l]) => [a.name, money(l.reduce((s, t) => s + t.amountCents, 0))])]));
  key["bank-statement"] = { detectable: false, ledger: false };
  key["bank-statement-amount"] = { ledger: false };
  key["pnl"] = { detectable: false, ledger: false };

  write("t4-2024.txt", [
    "Canada Revenue Agency    T4    Statement of Remuneration Paid    2024",
    "Employer's name: Brightwater Plumbing & Heating Ltd.",
    "Employee's name: BRIGHTWATER, DAN",
    "Box 14  Employment income         240,000.00",
    "Box 16  Employee's CPP contributions   4,034.10",
    "Box 18  Employee's EI premiums          1,049.12",
    "Box 22  Income tax deducted        78,412.55",
    "Sample document — fictional business",
    "",
  ].join("\n"));

  key["statements"] = statements(makeBooks([2022, 2023, 2024], { withAdjustments2023: true }));
  key["planted"] = {
    vehicleOwner: { account: "Automobile Expense:Vehicle - Owner", byYear: { "2022": VEHICLE_OWNER[2022], "2023": VEHICLE_OWNER[2023], "2024": VEHICLE_OWNER[2024] } },
    meals: { account: "Meals and Entertainment", byYear: MEALS },
    settlement: { account: "Legal & Professional Fees", date: "2024-07-15", amountCents: 2_200_000, name: "Holloway LLP" },
    ownerPay: { account: "Wages - Officers", perYear: 24_000_000, name: "Payroll — D. Brightwater" },
    spousePay: { account: "Wages & Salaries", perYear: 8_500_000, name: "Payroll — E. Brightwater" },
    lifeInsurance: { account: "Insurance", perYear: 900_000, name: "Sun Life" },
    golf: { account: "Dues & Memberships", perYear: 1_500_000, name: "Glen Abbey Golf Club" },
    yearEnd2023: { amortization: AMORT[2023], incomeTax: TAX[2023], total: AMORT[2023] + TAX[2023] },
  };
  write("answer-key.json", JSON.stringify(key, null, 2) + "\n");
  return key;
}

/** A big QBO-classic-style ledger (perf): `rows` entries across 180 accounts, 2022–2024, as CSV and XLSX. */
export function writeBench(outDir: string, rowsWanted: number): { csv: string; xlsx: string; rows: number } {
  fs.mkdirSync(outDir, { recursive: true });
  const rnd = mulberry32(7);
  const accts = Array.from({ length: 180 }, (_, i) => `${5000 + i * 10} · Expense account ${i + 1}`);
  const vendors = ["Petro-Canada", "Esso", "Staples", "Bell Canada", "Enbridge Gas", "The Home Depot", "Tim Hortons", "Lexus Financial", "Manulife", "Uline"];
  const header = ["", "Date", "Transaction Type", "Num", "Name", "Memo/Description", "Split", "Amount", "Balance"];
  const rows: unknown[][] = [[COMPANY], ["General Ledger"], ["January 1, 2022 - December 31, 2024"], [], header];
  const perAcct = Math.ceil(rowsWanted / accts.length);
  let made = 0;
  const start = Date.UTC(2022, 0, 1);
  for (let a = 0; a < accts.length && made < rowsWanted; a++) {
    rows.push([accts[a]]);
    let bal = 0;
    for (let i = 0; i < perAcct && made < rowsWanted; i++, made++) {
      const day = Math.floor((i / perAcct) * 1095);
      const d = new Date(start + day * 86400000).toISOString().slice(0, 10);
      const c = Math.round(rnd() * 500000);
      bal += c;
      rows.push(["", mdy(d), "Expense", String(10000 + made), vendors[made % 10], `Memo line ${made} for some purchase`, "1000 Chequing", money(c), money(bal)]);
    }
    rows.push([`Total for ${accts[a]}`, "", "", "", "", "", "", money(bal), ""]);
  }
  const csv = path.join(outDir, "gl-200k.csv");
  fs.writeFileSync(csv, toCsv(rows));
  const xlsx = path.join(outDir, "gl-200k.xlsx");
  writeXlsx(xlsx, rows.map((r) => r.map((c, i) => ((i === 7 || i === 8) && typeof c === "string" && /^-?\d+\.\d{2}$/.test(c) ? Number(c) : c))));
  return { csv, xlsx, rows: made };
}

// ── CLI ───────────────────────────────────────────────────────────────────
const isMain = (() => {
  try { return path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const rowsIdx = args.indexOf("--rows");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(here, "..", "tests", "fixtures", "gl");
  if (rowsIdx >= 0) {
    const r = writeBench(outDir, Number(args[rowsIdx + 1]) || 200_000);
    console.log(`bench ledger: ${r.rows.toLocaleString()} entries → ${r.csv} (${(fs.statSync(r.csv).size / 1e6).toFixed(1)} MB), ${r.xlsx} (${(fs.statSync(r.xlsx).size / 1e6).toFixed(1)} MB)`);
  } else {
    const key = writeFixtures(outDir);
    console.log(`fixtures written to ${outDir}: ${Object.keys(key).length} answer-key entries`);
  }
}
