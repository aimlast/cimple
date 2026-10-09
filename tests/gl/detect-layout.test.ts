/**
 * gl spec §12.1 test 1: the column-heading row and roles (account type
 * included), account modes, date order, software and basis — on the
 * fixtures and on hand-made edge cases; non-ledgers are not sniffed.
 */
import assert from "node:assert/strict";
import { test, done, fixture } from "./_harness";
import { detectLayout, roleOfHeader, sniffGeneralLedger, sniffLedger, softwareFrom } from "../../server/gl/detect";
import { peekRows } from "../../server/gl/read-file";
import type { GlRawRow } from "../../shared/gl-types";

const rows = (cells: Array<Array<string | number | null>>): GlRawRow[] => cells.map((c, i) => ({ sheet: null, rowNo: i + 1, cells: c }));

await test("heading words: exact, prefixed ('Debit (CAD)'), '#' read as 'no', never 'total' as the amount", () => {
  assert.equal(roleOfHeader("Debit (CAD)"), "debit");
  assert.equal(roleOfHeader("Source #"), "number");
  assert.equal(roleOfHeader("JE #"), "number");
  assert.equal(roleOfHeader("Account Type"), "account_type");
  assert.equal(roleOfHeader("Memo/Description"), "memo");
  assert.equal(roleOfHeader("Total"), "ignore");
  assert.equal(roleOfHeader("Gross"), "ignore");
  assert.equal(roleOfHeader("Something odd"), "unknown");
  assert.equal(roleOfHeader(""), null);
});

await test("the heading row below title rows, the best-scoring one", () => {
  const r = detectLayout(rows([
    ["Brightwater Plumbing & Heating Ltd."], ["General Ledger"], ["January 1 - December 31, 2024"], [],
    ["Date", "Account", "Account Type", "Name", "Description", "Debit", "Credit"],
    ["2024-01-03", "Vehicle - Owner", "Expense", "Lexus Financial", "Lease", "1150.00", ""],
    ["2024-01-05", "Rent", "Expense", "Holdings", "Rent", "4500.00", ""],
    ["2024-01-06", "Sales", "Revenue", "Customer", "Invoice", "", "900.00"],
  ]))!;
  assert.equal(r.layout.headerRow, 4);
  assert.deepEqual(r.layout.columns.map((c) => c.role), ["date", "account", "account_type", "name", "memo", "debit", "credit"]);
  assert.equal(r.layout.accountMode, "column");
  assert.equal(r.layout.amountMode, "debit_credit");
  assert.equal(r.layout.dateOrder, "ymd");
  assert.equal(r.accounts, 3);
  assert.equal(r.confidence, 1);
});

await test("date order: day-first when a first part is over 12; month-first when a second part is; else by fewer steps backwards", () => {
  const base = (dates: string[]) => detectLayout(rows([["Date", "Account", "Amount"], ...dates.map((d, i) => [d, `A${i % 3}`, "10.00"])]))!;
  assert.equal(base(["15/01/2024", "02/03/2024", "20/03/2024"]).layout.dateOrder, "dmy");
  assert.equal(base(["01/15/2024", "02/03/2024", "03/20/2024"]).layout.dateOrder, "mdy");
  const amb = base(["01/02/2024", "01/03/2024", "01/04/2024"]);
  assert.ok(["mdy", "dmy"].includes(amb.layout.dateOrder));
});

await test("software labels (copy only) and basis from the footer", async () => {
  assert.equal(softwareFrom(["", "Date", "Transaction Type", "Num", "Name", "Memo/Description", "Split", "Amount", "Balance"], "", []), "quickbooks_online");
  assert.equal(softwareFrom(["Date", "Source", "Description", "Reference", "Debit", "Credit", "Running Balance"], "", []), "xero");
  assert.equal(softwareFrom(["Date", "Comment", "Source #", "JE #", "Debits", "Credits", "Balance"], "", []), "sage50");
  assert.equal(softwareFrom(["Account", "Date", "Description", "Debit", "Credit"], "FreshBooks General Ledger", []), "freshbooks");
  assert.equal(softwareFrom(["Date", "Account", "Amount"], "", []), "other");
  const cash = detectLayout(await peekRows(fixture("qbo-cash-basis.csv"), "csv"));
  assert.equal(cash?.basis ?? null, null, "the footer is past the detector's look — the parser captures it");
});

await test("bank statements, P&Ls, odd layouts and membership/fleet lists are not general ledgers", async () => {
  for (const f of ["bank-statement.csv", "bank-statement-amount.csv", "pnl.csv", "odd.csv"]) {
    assert.equal(sniffGeneralLedger(await peekRows(fixture(f), "csv")), false, f);
  }
  const membership = rows([["Member", "Joined", "Plan", "Monthly fee"], ["A. Smith", "2024-01-03", "Gold", "89.00"], ["B. Jones", "2024-02-11", "Silver", "59.00"]]);
  assert.equal(sniffGeneralLedger(membership), false, "membership list");
  const fleet = rows([["Unit", "Year", "Make", "Model", "VIN", "Purchase date", "Cost"], ["101", "2019", "Ford", "Transit", "1FT…", "2019-04-02", "48000"]]);
  assert.equal(sniffGeneralLedger(fleet), false, "fleet list");
});

await test("GL-R2-03: reports shaped like a ledger are not ledgers — sales by customer, A/R aging (QuickBooks detail reports)", async () => {
  for (const f of ["sales-by-customer.csv", "ar-aging.csv"]) {
    const peek = await peekRows(fixture(`not-ledgers/${f}`), "csv", 2000, f);
    assert.ok((detectLayout(peek)?.confidence ?? 0) >= 0.6, `${f} has a ledger's layout (the trap)`);
    assert.equal(sniffLedger(peek, { minAccounts: 3 }), "no", `${f}: its title says what it is`);
    assert.equal(sniffGeneralLedger(peek), false, f);
  }
  // Without their title rows: still not a ledger — customers and aging buckets aren't a chart of accounts. "maybe" → read as a
  // normal document, the broker is offered "Read it as a ledger".
  for (const f of ["sales-by-customer-untitled.csv", "ar-aging-untitled.csv"]) {
    const peek = await peekRows(fixture(`not-ledgers/${f}`), "csv", 2000, f);
    assert.equal(sniffLedger(peek, { minAccounts: 3 }), "maybe", f);
    assert.equal(sniffLedger(peek, { minAccounts: 3, fileName: "Sales by Customer Detail 2024.xlsx" }), "no", `${f}: the file's name says what it is`);
    assert.equal(sniffLedger(peek, { minAccounts: 3, fileName: "General Ledger 2024.csv" }), "ledger", `${f}: the uploader named it a general ledger`);
  }
  // A customer named like an account ("TD Bank") doesn't turn a customer list into a chart of accounts.
  const banked = rows([
    ["", "Date", "Transaction Type", "Num", "Memo/Description", "Amount", "Balance"],
    ["Acme Corp"], ["", "01/15/2024", "Invoice", "1", "Service", "100.00", "100.00"], ["", "02/15/2024", "Invoice", "2", "Service", "120.00", "220.00"],
    ["TD Bank"], ["", "01/16/2024", "Invoice", "3", "Service", "90.00", "90.00"], ["", "02/16/2024", "Invoice", "4", "Service", "95.00", "185.00"],
    ["Coastal Foods"], ["", "01/17/2024", "Invoice", "5", "Service", "80.00", "80.00"], ["", "02/17/2024", "Invoice", "6", "Service", "85.00", "165.00"],
    ["Delta Grocers"], ["", "01/18/2024", "Invoice", "7", "Service", "70.00", "70.00"],
  ]);
  assert.notEqual(sniffLedger(banked, { minAccounts: 3 }), "ledger");
  // Every real export is still a ledger — by its title, or (Wave, QuickBooks Desktop, a flat export) by a chart of accounts.
  for (const f of ["qbo-classic.csv", "qbd.csv", "wave.csv", "sage50.csv", "xero-account-transactions.csv", "freshbooks.csv", "account-type.csv", "payroll-provider.csv", "qbo-cash-basis.csv"]) {
    assert.equal(sniffLedger(await peekRows(fixture(f), "csv", 2000, f), { minAccounts: 3 }), "ledger", f);
  }
  for (const f of ["qbo-classic.xlsx", "qbo-modern.xlsx", "xero-gl-detail.xlsx"]) {
    assert.equal(sniffLedger(await peekRows(fixture(f), "xlsx", 2000, f), { minAccounts: 3 }), "ledger", f);
  }
  // An untitled flat export with a chart of accounts (no title rows at all) is a ledger by its accounts.
  const flat = rows([
    ["Date", "Account", "Name", "Memo", "Debit", "Credit"],
    ["2024-01-02", "Sales - Service", "Maple Ridge", "Call", "", "400.00"], ["2024-01-02", "Chequing", "Maple Ridge", "Call", "400.00", ""],
    ["2024-01-03", "Fuel", "Petro-Canada", "Vans", "60.00", ""], ["2024-01-03", "Chequing", "Petro-Canada", "Vans", "", "60.00"],
    ["2024-01-04", "Rent", "Landlord", "Jan", "1500.00", ""], ["2024-01-04", "Chequing", "Landlord", "Jan", "", "1500.00"],
  ]);
  assert.equal(sniffLedger(flat, { minAccounts: 3 }), "ledger");
});

await test("the odd layout has no recognisable headings at all (the AI-mapping stub's case)", async () => {
  assert.equal(detectLayout(await peekRows(fixture("odd.csv"), "csv")), null);
});

done("detect-layout");
