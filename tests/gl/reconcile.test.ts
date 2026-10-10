/**
 * gl spec §12.1 tests 15, 16, 17: reconciliation tiers ($250 floor, refunds,
 * shares, documents, left-out years, private-only), the suggested verdict;
 * the document amount check; the tie-out (agrees, year-end entries,
 * cash basis, partial year, unclassified accounts, broker classes, account
 * type column, numbered chart).
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { amountStatus, overallStatus, reconcileTrace, reconcileWords, suggestedVerdict, targetCents, type ReconcileLink } from "../../shared/gl-reconcile";
import { amountAppearsIn } from "../../server/gl/doc-check";
import { classifyAccount, tieOutSummary, tieOutWords, tieOutYear } from "../../server/gl/tie-out";
import { brokerCellWords, sellerChipWords, yearsWords } from "../../shared/gl-copy";

const L = (fiscalYear: string, amountCents: number, over: Partial<ReconcileLink> = {}): ReconcileLink =>
  ({ fiscalYear, amountCents, state: "confirmed", ledgerId: "L1", documentId: null, ...over });
const ctx = { ledgerYears: new Set(["2022", "2023", "2024"]), hasLedger: true };

await test("tiers: within max(2%, $250) adds up; within 15% close; else short / over", () => {
  assert.equal(amountStatus(2_784_000, 2_800_000), "found", "$160 short of $28,000 adds up");
  assert.equal(amountStatus(2_775_000, 2_800_000), "found", "$250 floor");
  assert.equal(amountStatus(2_700_000, 2_800_000), "close");
  assert.equal(amountStatus(1_200_000, 2_600_000), "short");
  assert.equal(amountStatus(3_100_000, 2_800_000), "close", "$3,000 over is within 15%");
  assert.equal(amountStatus(3_300_000, 2_800_000), "over");
  assert.equal(amountStatus(20_000, 10_000), "found", "small claims: the $250 floor");
});

await test("a portion: entries are the whole cost (claim ÷ share)", () => {
  assert.equal(targetCents(1_100_000, 50), 2_200_000);
  assert.equal(targetCents(1_100_000, null), 1_100_000);
  assert.equal(targetCents(1_100_000, 100), 1_100_000);
  const r = reconcileTrace({ proof: "ledger", sharePct: 50, claims: { "2024": 1_100_000 }, leftOut: null, notInLedger: null }, [L("2024", 2_200_000)], ctx);
  assert.equal(r.byYear["2024"].status, "found");
  assert.equal(r.byYear["2024"].targetCents, 2_200_000);
});

await test("refund netting moves the status the right way", () => {
  const r = reconcileTrace(
    { proof: "one_off", sharePct: null, claims: { "2024": 2_200_000 }, leftOut: null, notInLedger: null },
    [L("2024", 2_200_000), L("2024", -50_000), L("2024", 900, { state: "proposed" }), L("2024", 1, { state: "rejected" })],
    ctx,
  );
  assert.equal(r.byYear["2024"].foundCents, 2_150_000);
  assert.equal(r.byYear["2024"].status, "close", "$500 short of $22,000: not within 2%, within 15%");
  assert.equal(r.byYear["2024"].proposed, 1);
  assert.equal(r.byYear["2024"].confirmed, 2);
  const none = reconcileTrace({ proof: "ledger", sharePct: null, claims: { "2024": 100 }, leftOut: null, notInLedger: null }, [L("2024", 100, { state: "proposed" })], ctx);
  assert.equal(none.byYear["2024"].status, "not_started");
});

await test("not in ledger: the seller said so, or no ledger covers the year; no ledger at all = not started", () => {
  const t = { proof: "ledger", sharePct: null, claims: { "2021": 100_000, "2024": 100_000 }, leftOut: null, notInLedger: null };
  const r = reconcileTrace(t, [], ctx);
  assert.equal(r.byYear["2021"].status, "not_in_ledger");
  assert.equal(r.byYear["2021"].reason, "not_in_this_ledger");
  assert.equal(r.byYear["2024"].status, "not_started");
  const noLedger = reconcileTrace(t, [], { ledgerYears: new Set(), hasLedger: false });
  assert.equal(noLedger.byYear["2021"].status, "not_started");
  const said = reconcileTrace({ ...t, notInLedger: { reason: "personal", at: "x" } }, [], ctx);
  assert.equal(said.byYear["2024"].status, "not_in_ledger");
  assert.equal(said.byYear["2024"].reason, "seller_personal");
  const oneYear = reconcileTrace({ ...t, notInLedger: { reason: "personal", at: "x", years: ["2021"] } }, [], ctx);
  assert.equal(oneYear.byYear["2024"].status, "not_started", "only the year the seller named");
});

await test("documents: a T4 carries the year; one whose amount wasn't seen asks the broker to check", () => {
  const t = { proof: "payroll", sharePct: null, claims: { "2024": 24_000_000 }, leftOut: null, notInLedger: null };
  const seen = reconcileTrace(t, [L("2024", 24_000_000, { ledgerId: null, documentId: "D1", docAmountCheck: "found_in_document" })], ctx);
  assert.equal(seen.byYear["2024"].status, "document");
  assert.equal(seen.suggestedVerdict, "found");
  const unseen = reconcileTrace(t, [L("2024", 24_000_000, { ledgerId: null, documentId: "D1", docAmountCheck: "not_found" })], ctx);
  assert.equal(unseen.byYear["2024"].status, "document");
  assert.equal(unseen.byYear["2024"].reason, "check_document");
  assert.equal(unseen.suggestedVerdict, "partly_found", "the broker looks first");
  assert.equal(brokerCellWords(unseen.byYear["2024"], "T4"), "Check the T4");
  assert.equal(brokerCellWords(seen.byYear["2024"], "T4"), "Shown by the T4");
});

await test("left-out years and statements; overall = the worst year; verdicts", () => {
  const t = { proof: "ledger", sharePct: null, claims: { "2023": 1_000_000, "2024": 1_000_000 }, leftOut: { years: ["2023"], reason: "Not in the books that year" }, notInLedger: null };
  const r = reconcileTrace(t, [L("2024", 1_000_000)], ctx);
  assert.equal(r.byYear["2023"].status, "left_out");
  assert.equal(r.overall, "found");
  assert.equal(r.suggestedVerdict, "found");
  const st = reconcileTrace({ ...t, proof: "statement", leftOut: null }, [], ctx);
  assert.equal(st.overall, "statement");
  assert.equal(overallStatus({ a: { status: "found" }, b: { status: "short" }, c: { status: "close" } }), "short");
  assert.equal(overallStatus({ a: { status: "found" }, b: { status: "not_started" } }), "not_started");
  assert.equal(suggestedVerdict({ a: { status: "found", confirmed: 3 }, b: { status: "short", confirmed: 2 } }), "partly_found");
  assert.equal(suggestedVerdict({ a: { status: "not_started", confirmed: 0 } }), "not_found");
});

await test("private-only: the found entries all sit in a ledger private to the broker", () => {
  const r = reconcileTrace(
    { proof: "ledger", sharePct: null, claims: { "2024": 100_000 }, leftOut: null, notInLedger: null },
    [L("2024", 100_000, { ledgerId: "P" })],
    { ...ctx, brokerOnlyLedgerIds: new Set(["P"]) },
  );
  assert.equal(r.byYear["2024"].privateOnly, true);
  const seller = reconcileTrace(
    { proof: "ledger", sharePct: null, claims: { "2024": 100_000 }, leftOut: null, notInLedger: null },
    [L("2024", 100_000, { ledgerId: "P" })],
    { ...ctx, countedLedgerIds: new Set(["S"]) },
  );
  assert.equal(seller.byYear["2024"].status, "not_started", "the seller's view never counts the broker's private ledger");
});

await test("words: reconcile bar, seller chips, broker cells, years", () => {
  assert.equal(reconcileWords(2_784_000, 2_800_000).words, "Adds up");
  assert.equal(reconcileWords(2_700_000, 2_800_000).words, "Close — $1,000 short");
  assert.equal(reconcileWords(1_400_000, 2_800_000).words, "$14,000 short");
  assert.equal(reconcileWords(3_120_000, 2_800_000).words, "Close — $3,200 over");
  assert.equal(reconcileWords(3_300_000, 2_800_000).words, "$5,000 more than the cost");
  assert.equal(sellerChipWords("2024", { status: "found", diffCents: 0 }), "2024 · Done");
  assert.equal(sellerChipWords("2023", { status: "close", diffCents: -16_000 }), "2023 · Almost — $160 short");
  assert.equal(sellerChipWords("2022", { status: "short", diffCents: -1 }), "2022 · Needs you");
  assert.equal(brokerCellWords({ status: "short", foundCents: 1_200_000, documentCents: 0, targetCents: 2_600_000, diffCents: -1_400_000 }), "$12,000 of $26,000");
  assert.equal(brokerCellWords({ status: "found", foundCents: 2_814_000, documentCents: 0, targetCents: 2_800_000, diffCents: 14_000 }), "Adds up · $28,140");
  assert.equal(brokerCellWords({ status: "close", foundCents: 2_760_000, documentCents: 0, targetCents: 2_800_000, diffCents: -40_000 }), "Close — $400 short");
  assert.equal(yearsWords(["2024", "2022", "2023"]), "2022–2024");
  assert.equal(yearsWords(["2022", "2024"]), "2022 and 2024");
});

await test("doc check: the typed amount on a T4; not there; a scan with no text", () => {
  const t4 = "STATEMENT OF REMUNERATION PAID T4 2024 Employer: Brightwater Plumbing & Heating Ltd. Box 14 Employment income 240000.00 Box 22 Income tax deducted 61,234.10";
  assert.equal(amountAppearsIn(t4, 24_000_000), "found_in_document");
  assert.equal(amountAppearsIn("Employment income 240,000.00 for 2024 on this slip", 24_000_000), "found_in_document");
  assert.equal(amountAppearsIn("Box 14 Employment income 240 000 00 tax year 2024", 24_000_000), "found_in_document");
  assert.equal(amountAppearsIn(t4, 23_500_000), "not_found");
  assert.equal(amountAppearsIn("", 24_000_000), "unreadable");
  assert.equal(amountAppearsIn("   \n  ", 24_000_000), "unreadable");
});

await test("account classes: broker → account type → numbered chart → name words", () => {
  assert.equal(classifyAccount("Chequing", null, null), "balance_sheet");
  assert.equal(classifyAccount("HST Payable", null, null), "balance_sheet");
  assert.equal(classifyAccount("Accumulated Amortization", null, null), "balance_sheet");
  assert.equal(classifyAccount("Shareholder Loan", null, null), "balance_sheet");
  assert.equal(classifyAccount("Owner Draws", null, null), "balance_sheet");
  assert.equal(classifyAccount("Sales - Service", null, null), "revenue");
  assert.equal(classifyAccount("Income Tax Expense", null, null), "expense");
  assert.equal(classifyAccount("Sales & Marketing Expense", null, null), "expense");
  assert.equal(classifyAccount("Automobile Expense:Vehicle - Owner", null, null), "expense");
  assert.equal(classifyAccount("Vehicles", null, null), "balance_sheet", "a fixed-asset name without expense words");
  assert.equal(classifyAccount("Vehicle Repairs", null, null), "expense");
  assert.equal(classifyAccount("Bank Charges", null, null), "expense");
  assert.equal(classifyAccount("Mystery", null, "Current Asset"), "balance_sheet", "the export's type wins over the name");
  assert.equal(classifyAccount("Sales", null, "Expense"), "expense");
  assert.equal(classifyAccount("Misc", "1200", null, {}, true), "balance_sheet");
  assert.equal(classifyAccount("Misc", "4100", null, {}, true), "revenue");
  assert.equal(classifyAccount("Misc", "6100", null, {}, true), "expense");
  assert.equal(classifyAccount("Chequing", null, null, { chequing: "expense" }, false, "chequing"), "expense", "the broker's choice wins");
  assert.equal(classifyAccount("1234", null, null), "unknown");
});

const acct = (account: string, netCents: number, over: Record<string, unknown> = {}) => ({ accountKey: account.toLowerCase(), account, netCents, ...over });
const yearInput = (accounts: ReturnType<typeof acct>[], over: Record<string, unknown> = {}) => ({
  accounts, statements: { revenueCents: 100_000_000, netIncomeCents: 10_000_000, yearEndCents: 4_120_000 }, basis: "accrual" as const, monthsCovered: 12, hasYearEndAccounts: false, ...over,
});

await test("tie-out: agrees within max($1,000, 0.5% of revenue)", () => {
  const t = tieOutYear(yearInput([acct("Sales", -100_000_000), acct("Wages", 89_950_000), acct("Chequing", 5_000_000)]));
  assert.equal(t.state, "agrees");
  assert.equal(t.revenue?.ledger, 100_000_000);
  assert.equal(t.netIncome?.ledger, 10_050_000);
  assert.equal(tieOutWords("2024", t), "2024: the ledger matches the statements.");
});

await test("tie-out: the accountant's year-end entries (amortization + income tax) missing from the export", () => {
  const t = tieOutYear(yearInput([acct("Sales", -100_000_000), acct("Wages", 85_880_000)]));
  assert.equal(t.state, "differs");
  assert.equal(t.likelyReason, "year_end_entries");
  assert.equal(t.differenceCents, 4_120_000);
  assert.match(tieOutWords("2023", t), /2023: the ledger's net income differs from the statements by \$41,200 — likely the accountant's year-end entries/);
  const withAmort = tieOutYear(yearInput([acct("Sales", -100_000_000), acct("Wages", 85_880_000)], { hasYearEndAccounts: true }));
  assert.equal(withAmort.likelyReason, null, "the ledger has amortization entries → not that");
  assert.match(tieOutWords("2023", withAmort), /can't tell why/);
  assert.match(tieOutWords("2023", t, { note: "Accountant's entries" }), /you accepted it/);
});

await test("tie-out: cash basis, partial year, no statements, unclassified accounts", () => {
  const cash = tieOutYear(yearInput([acct("Sales", -90_000_000), acct("Wages", 85_000_000)], { basis: "cash" }));
  assert.equal(cash.state, "differs");
  assert.equal(cash.likelyReason, "cash_basis");
  assert.equal(tieOutYear(yearInput([acct("Sales", -100_000_000)], { monthsCovered: 7 })).likelyReason, "partial_year");
  const none = tieOutYear(yearInput([acct("Sales", -100_000_000)], { statements: null }));
  assert.equal(none.state, "cannot_check");
  assert.equal(none.likelyReason, "no_statements");
  const unk = tieOutYear(yearInput([acct("Sales", -100_000_000), acct("Wages", 89_950_000), acct("4471", 3_000_000)]));
  assert.equal(unk.likelyReason, "unclassified_accounts");
  assert.equal(unk.unclassified?.[0].account, "4471");
  const fixed = tieOutYear({ ...yearInput([acct("Sales", -100_000_000), acct("Wages", 89_950_000), acct("4471", 3_000_000)]), overrides: { "4471": "balance_sheet" } });
  assert.equal(fixed.state, "agrees", "the broker's toggle settles it");
});

await test("tie-out summary in one line", () => {
  const agrees = { state: "agrees" as const };
  const differs = { state: "differs" as const, differenceCents: 4_120_000, likelyReason: "year_end_entries" as const };
  assert.deepEqual(tieOutSummary({ "2022": agrees, "2023": agrees, "2024": agrees }), { tone: "good", text: "2022–2024 match" });
  assert.equal(tieOutSummary({ "2022": agrees, "2023": differs }).text, "2023 differs by $41,200 — likely the accountant's year-end entries");
  assert.equal(tieOutSummary({ "2022": agrees, "2023": differs }, { "2023": { note: "ok" } }).text, "2022–2023 match");
  assert.equal(tieOutSummary({}).text, "Can't check yet — no ledger");
});

done("reconcile / doc-check / tie-out");
