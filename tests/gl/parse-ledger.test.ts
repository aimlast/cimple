/**
 * gl spec §12.1 tests 1–2: every fictional export is detected and parsed to
 * exactly the answer key (per account, per year), totals/opening rows
 * skipped, QBD nesting, money formats, dates, Windows-1252, page breaks.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test, done, fixture } from "./_harness";
import { peekRows, readLedgerRows, ledgerFileKind } from "../../server/gl/read-file";
import { detectLayout, sniffGeneralLedger } from "../../server/gl/detect";
import { LedgerParser } from "../../server/gl/parse";
import { accountKey } from "../../server/gl/text";
import type { GlParsedEntry } from "../../shared/gl-types";

const key = JSON.parse(fs.readFileSync(fixture("answer-key.json"), "utf8"));

async function parseFile(file: string) {
  const kind = ledgerFileKind(file)!;
  const peek = await peekRows(fixture(file), kind, undefined, file);
  const det = detectLayout(peek);
  assert.ok(det, `${file}: no layout`);
  const parser = new LedgerParser(det!.layout);
  const entries: GlParsedEntry[] = [];
  await readLedgerRows(fixture(file), kind, (rows) => { for (const r of rows) parser.push(r); entries.push(...parser.take()); }, { fileName: file });
  entries.push(...parser.take(true));
  return { det: det!, entries, stats: parser.stats };
}

function totalsOf(entries: GlParsedEntry[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    const y = e.txnDate.slice(0, 4);
    out[e.accountKey] = out[e.accountKey] ?? {};
    out[e.accountKey][y] = (out[e.accountKey][y] ?? 0) + e.amountCents;
  }
  return out;
}

const CASES: Array<[string, string]> = [
  ["qbo-classic.csv", "qbo-classic"], ["qbo-classic.xlsx", "qbo-classic-xlsx"], ["qbo-2024-only.csv", "qbo-2024-only"],
  ["qbo-cash-basis.csv", "qbo-cash-basis"], ["qbo-modern.xlsx", "qbo-modern"], ["qbd.csv", "qbd"],
  ["xero-account-transactions.csv", "xero-account-transactions"], ["xero-gl-detail.xlsx", "xero-gl-detail"],
  ["sage50.csv", "sage50"], ["wave.csv", "wave"], ["freshbooks.csv", "freshbooks"], ["account-type.csv", "account-type"],
  ["payroll-provider.csv", "payroll-provider"], ["adjustments.csv", "adjustments"],
];

for (const [file, k] of CASES) {
  await test(`${file}: layout and totals match the answer key`, async () => {
    const want = key[k];
    const { det, entries, stats } = await parseFile(file);
    if (want.software) assert.equal(det.software, want.software, "software");
    if (want.basis) assert.equal(det.basis ?? stats.basis, want.basis, "basis");
    if (want.accountMode) assert.equal(det.layout.accountMode, want.accountMode, "account mode");
    if (want.amountMode) assert.equal(det.layout.amountMode, want.amountMode, "amount mode");
    if (want.dateOrder) assert.equal(det.layout.dateOrder, want.dateOrder, "date order");
    assert.equal(entries.length, want.entries, "entry count");
    assert.equal(stats.skipped, 0, "nothing that looked like data was skipped");
    const got = totalsOf(entries);
    const expected: Record<string, Record<string, number>> = {};
    for (const [acct, years] of Object.entries(want.accounts as Record<string, Record<string, number>>)) expected[accountKey(acct)] = years;
    assert.deepEqual(got, expected);
  });
}

await test("non-ledgers are not general ledgers", async () => {
  for (const f of ["bank-statement.csv", "bank-statement-amount.csv", "pnl.csv", "odd.csv"]) {
    const peek = await peekRows(fixture(f), "csv", undefined, f);
    assert.equal(sniffGeneralLedger(peek), false, f);
    assert.equal(sniffGeneralLedger(peek, { minAccounts: 1 }), false, `${f} (GL screens)`);
  }
  for (const f of ["qbo-classic.csv", "qbd.csv", "wave.csv", "sage50.csv", "xero-account-transactions.csv"]) {
    const peek = await peekRows(fixture(f), "csv", undefined, f);
    assert.equal(sniffGeneralLedger(peek), true, f);
  }
});

await test("planted entries: the settlement, its refund, the owner's vehicle and the pharmacy", async () => {
  const { entries } = await parseFile("qbo-classic.csv");
  const settlement = entries.find((e) => e.name === "Holloway LLP" && e.amountCents === 2_200_000);
  assert.ok(settlement);
  assert.equal(settlement!.txnDate, "2024-07-15");
  assert.equal(settlement!.account, "Legal & Professional Fees");
  const refund = entries.find((e) => e.name === "Holloway LLP" && e.amountCents === -50_000);
  assert.ok(refund, "the refund is a negative entry");
  const lexus = entries.filter((e) => e.name === "Lexus Financial" && e.txnDate.startsWith("2024"));
  assert.equal(lexus.length, 12);
  assert.ok(lexus.every((e) => e.account === "Automobile Expense:Vehicle - Owner" && e.accountKey === "automobile expense:vehicle owner"));
  const pharmacy = entries.find((e) => e.name === "Shoppers Drug Mart");
  assert.equal(pharmacy?.account, "Shareholder Expenses");
});

await test("QuickBooks Desktop: numbers split off, nesting kept, (500.00) in Credit is a credit", async () => {
  const { entries } = await parseFile("qbd.csv");
  const v = entries.find((e) => e.name === "Lexus Financial")!;
  assert.equal(v.account, "Automobile Expense:Vehicle - Owner");
  assert.equal(v.accountNumber, "6110");
  const refund = entries.find((e) => e.name === "Holloway LLP" && e.amountCents < 0)!;
  assert.equal(refund.amountCents, -50_000);
  assert.equal(refund.creditCents, 50_000);
  const big = entries.find((e) => e.name === "Holloway LLP" && e.amountCents > 0)!;
  assert.equal(big.amountCents, 2_200_000, '"22,000.00" read');
});

await test("Sage 50: Windows-1252 names and page breaks", async () => {
  const { entries, det } = await parseFile("sage50.csv");
  assert.ok(entries.some((e) => (e.memo ?? "").includes("Café Novo")), "é decoded from Windows-1252");
  assert.ok(entries.every((e) => !/General Ledger Report|Brightwater Plumbing/.test(e.account)), "page titles never become accounts");
  assert.equal(det.layout.dateOrder, "mdy");
});

await test("Xero: day-first dates and the account code from the heading", async () => {
  const { entries } = await parseFile("xero-account-transactions.csv");
  const s = entries.find((e) => e.memo?.includes("Holloway LLP") && e.amountCents === 2_200_000)!;
  assert.equal(s.txnDate, "2024-07-15");
  assert.equal(s.accountNumber, "6400");
});

await test("Wave: the vendor column fills the name when the customer column is empty", async () => {
  const { entries } = await parseFile("wave.csv");
  assert.ok(entries.find((e) => e.name === "Lexus Financial"));
  assert.ok(entries.find((e) => e.name === "Halton Property Group"));
  assert.ok(entries.every((e) => e.accountType), "account type column read");
});

await test("Excel date cells read the same in every time zone", async () => {
  const { entries } = await parseFile("xero-gl-detail.xlsx");
  assert.ok(entries.find((e) => e.txnDate === "2024-07-15" && e.amountCents === 2_200_000));
  assert.ok(entries.every((e) => /^2024-\d{2}-\d{2}$/.test(e.txnDate)));
});

done("parse-ledger");
