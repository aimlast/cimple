/**
 * gl spec §12.1 test 1: the column-heading row and roles (account type
 * included), account modes, date order, software and basis — on the
 * fixtures and on hand-made edge cases; non-ledgers are not sniffed.
 */
import assert from "node:assert/strict";
import { test, done, fixture } from "./_harness";
import { detectLayout, roleOfHeader, sniffGeneralLedger, softwareFrom } from "../../server/gl/detect";
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

await test("the odd layout has no recognisable headings at all (the AI-mapping stub's case)", async () => {
  assert.equal(detectLayout(await peekRows(fixture("odd.csv"), "csv")), null);
});

done("detect-layout");
