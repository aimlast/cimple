// SECOND free round, stream "finance-facts", round 3: the checker's round-2 regressions,
// proved offline (no model call).
//  F2-04/05  an add-back's claim is compared over the period of the linked transactions' OWN
//            source (their GL or bank statement), widened to the whole years they fall in but
//            never past that source — recent bank statements or another year's GL never stretch
//            a fiscal-year claim (the route reads every GL / bank / financials upload at once)
//  F2-05     a discovered add-back naming a whole account at a clear portion of its total
//            (above-market rent named with the Rent account) keeps the model's portion
//  F2-03     a numbered fleet unit ("Truck lease - Unit 7"), a lessor's "commercial lease" form or
//            "tenant" don't turn a title that says outright what equipment is leased into premises
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-finance-facts-r3.test.ts
import assert from "node:assert/strict";
import { addbackEvidenceLine, addbackSupport, claimPeriodYears, evidencedAmount } from "../../shared/addback-support";
import { settleDiscovered, settleMatch, type ParsedTransaction } from "../../server/financial/addback-verifier";
import { isEquipmentLeaseTitle, isPremisesLeaseTitle } from "../../server/documents/lease-kind";
import { mergeExtractedData } from "../../server/documents/extractor";

const ok = (msg: string) => console.log(`✓ ${msg}`);

type Tx = ParsedTransaction & { documentId?: string };
const monthly = (amt: number, year: number, months: number, startMonth: number, account: string, documentId: string, source: Tx["source"] = "gl"): Tx[] =>
  Array.from({ length: months }, (_, i) => {
    const m = startMonth + i;
    const y = year + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    return { date: `${y}-${String(mm).padStart(2, "0")}-15`, description: `${account} payment`, amount: amt, account, source, category: account.toLowerCase(), rawLine: "", documentId };
  });
const daily = (fromIso: string, days: number, documentId: string): Tx[] => Array.from({ length: days }, (_, i) => ({
  date: new Date(Date.parse(fromIso) + i * 86_400_000).toISOString().slice(0, 10), description: "POS deposit", amount: 420, account: "Bank",
  source: "bank", category: "deposit", rawLine: "", documentId,
}));
const indicesOf = (txs: Tx[], pred: (t: Tx) => boolean) => txs.map((_, i) => i).filter((i) => pred(txs[i]));

// ── A FY2024 GL next to Jul–Sep 2025 bank statements (the route's default reading) ──
{
  const gl = [...monthly(10000, 2024, 12, 1, "Owner salary", "gl24"), ...monthly(1500, 2024, 12, 1, "Vehicle", "gl24"), ...monthly(3000, 2024, 12, 1, "Utilities", "gl24")];
  const bank = daily("2025-07-01", 92, "bank25");
  const all = [...gl, ...bank];
  const sal = indicesOf(all, (t) => t.account === "Owner salary");
  const shown = new Set(all.map((_, i) => i));

  // Workflow A (verify the broker's add-backs): matched, $120,000 — not "$207,001 for 1 year 9 months".
  const ab = { id: "s", label: "Owner salary", category: "owner_comp", annualAmount: 120000, yearAmounts: { "2024": 120000 }, description: "" };
  const a = settleMatch(ab as never, { verificationStatus: "matched", matchedTransactionIndices: sal }, all, "gl24");
  assert.equal(a.verificationStatus, "matched");
  assert.equal(a.claimedAmount, 120000);
  const row = { ...ab, verificationStatus: a.verificationStatus, matchedTransactions: a.matchedTransactions, totalMatchedAmount: a.totalMatchedAmount, claimedAmount: a.claimedAmount };
  assert.equal(evidencedAmount(row), 120000);
  assert.match(addbackEvidenceLine(row), /supported by the ledger — \$120,000 claimed, \$120,000 in 12 supporting transactions/);
  assert.doesNotMatch(addbackEvidenceLine(row), /partly|not evidenced|ledger covers/);

  // The screenshot's case: 12 × $15,000 against $180,000.
  const gl15 = [...monthly(15000, 2024, 12, 1, "Owner salary", "gl24"), ...monthly(1500, 2024, 12, 1, "Vehicle", "gl24")];
  const mixed = [...gl15, ...bank];
  const r15 = settleMatch({ ...ab, annualAmount: 180000, yearAmounts: { "2024": 180000 } } as never,
    { verificationStatus: "matched", matchedTransactionIndices: indicesOf(mixed, (t) => t.account === "Owner salary") }, mixed, "gl24");
  assert.equal(r15.verificationStatus, "matched");
  assert.equal(r15.claimedAmount, 180000);

  // Workflow B (discovered): the account named → $120,000 a year, no "scaled to a year" note.
  const named = settleDiscovered({ label: "Owner salary", category: "owner_comp", annualAmount: 120000, accounts: ["Owner salary"], matchedTransactionIndices: sal }, all, shown);
  assert.equal(named.annualAmount, 120000);
  assert.equal(named.verificationStatus, "matched");
  assert.doesNotMatch(named.aiNotes, /Scaled|first estimate/);
  // …and the same lines cited without the account.
  const cited = settleDiscovered({ label: "Owner salary", category: "owner_comp", annualAmount: 120000, matchedTransactionIndices: sal }, all, shown);
  assert.equal(cited.verificationStatus, "matched");
  assert.equal(cited.claimedAmount, 120000);

  // The UI hand-link (stored transactions carry their documentId): the same.
  const linked = all.filter((t) => t.account === "Owner salary").map((t) => ({ ...t, confidence: 1 }));
  assert.deepEqual(addbackSupport({ annualAmount: 120000, yearAmounts: { "2024": 120000 } }, linked, all), { status: "matched", supported: 120000, claimed: 120000 });

  // Rent paid in the bank statements' three months is still compared with a quarter of the year.
  const withRent = [...all, ...monthly(5000, 2025, 3, 7, "Rent", "bank25", "bank")];
  const rent = settleMatch({ id: "r", label: "Related-party rent", category: "related_party", annualAmount: 60000, yearAmounts: {}, description: "" } as never,
    { verificationStatus: "matched", matchedTransactionIndices: indicesOf(withRent, (t) => t.account === "Rent") }, withRent, "bank25");
  assert.equal(rent.verificationStatus, "matched");
  assert.ok(Math.abs(rent.claimedAmount - 15000) < 400, String(rent.claimedAmount));
  ok("a FY2024 GL next to 2025 bank statements: the GL's salary is a one-year claim (A, B, hand-link); the statements' rent a quarter");
}

// ── A two-year GL, the claim for one of its years ──────────────────────────────
{
  const gl = [...monthly(9000, 2023, 12, 1, "Owner salary", "gl"), ...monthly(10000, 2024, 12, 1, "Owner salary", "gl")];
  const y24 = indicesOf(gl, (t) => t.date.startsWith("2024"));
  const one = settleMatch({ id: "s", label: "Owner salary", category: "owner_comp", annualAmount: 120000, yearAmounts: { "2024": 120000 }, description: "" } as never,
    { verificationStatus: "matched", matchedTransactionIndices: y24 }, gl, "gl");
  assert.equal(one.verificationStatus, "matched");
  assert.equal(one.claimedAmount, 120000);
  // Both years cited: both years' claim, each year's own amount.
  const both = settleMatch({ id: "s", label: "Owner salary", category: "owner_comp", annualAmount: 120000, yearAmounts: { "2023": 108000, "2024": 120000 }, description: "" } as never,
    { verificationStatus: "matched", matchedTransactionIndices: gl.map((_, i) => i) }, gl, "gl");
  assert.equal(both.claimedAmount, 228000);
  assert.equal(both.verificationStatus, "matched");
  // A FY2023 GL and a FY2024 GL uploaded separately add up to two years.
  const two = [...monthly(9000, 2023, 12, 1, "Owner salary", "gl23"), ...monthly(10000, 2024, 12, 1, "Owner salary", "gl24")];
  assert.equal(claimPeriodYears(two, two)?.toFixed(2), (claimPeriodYears(two.slice(0, 12), two)! * 2).toFixed(2));
  ok("the 2024 payments in a two-year GL are compared with 2024's claim; both years with both; two yearly GLs are two years");
}

// ── What the ledger still shows: missing months, short sources, longer periods ──
{
  // Oct–Dec vehicle charges in a twelve-month GL: a year's claim, partly supported.
  const gl = [...monthly(3000, 2024, 12, 1, "Utilities", "gl"), ...monthly(5000, 2024, 3, 10, "Vehicle", "gl")];
  const veh = addbackSupport({ annualAmount: 60000 }, gl.filter((t) => t.account === "Vehicle"), gl);
  assert.equal(veh.status, "partial_match");
  assert.equal(veh.claimed, 60000);
  // Six of twelve salary payments linked: partly supported.
  const sal = monthly(10000, 2024, 12, 1, "Owner salary", "gl");
  assert.equal(addbackSupport({ annualAmount: 120000 }, sal.slice(0, 6), sal).status, "partial_match");
  // Payments across a 15-month and an 18-month GL: that period, matched.
  const m15 = monthly(10000, 2023, 15, 10, "Owner salary", "gl");
  assert.equal(addbackSupport({ annualAmount: 120000 }, m15, m15).status, "matched");
  const m18 = monthly(10000, 2024, 18, 1, "Owner salary", "gl");
  const s18 = addbackSupport({ annualAmount: 120000 }, m18, m18);
  assert.equal(s18.status, "matched");
  assert.equal(s18.periodMonths, 18);
  // Two bonuses a year apart in a two-year GL: two years.
  const bonusGl = [...monthly(3000, 2023, 24, 1, "Utilities", "gl"), { ...monthly(20000, 2023, 1, 12, "Bonus", "gl")[0] }, { ...monthly(20000, 2024, 1, 12, "Bonus", "gl")[0] }];
  assert.deepEqual(addbackSupport({ annualAmount: 20000 }, bonusGl.filter((t) => t.account === "Bonus"), bonusGl), { status: "matched", supported: 40000, claimed: 40000 });
  // The same line in the GL and in a bank statement: a bank-linked line is the bank statement's.
  const glSal = monthly(10000, 2025, 12, 1, "Owner salary", "gl25");
  const bankSal = monthly(10000, 2025, 3, 7, "Owner salary", "bank25", "bank");
  const ledger = [...glSal, ...bankSal];
  assert.ok(Math.abs((claimPeriodYears(bankSal, ledger) ?? 0) - 0.25) < 0.02);
  assert.ok(Math.abs((claimPeriodYears(glSal, ledger) ?? 0) - 1) < 0.02);
  // No ledger (older rows): the linked lines' own span, as before.
  assert.ok(Math.abs((claimPeriodYears(monthly(5000, 2024, 3, 10, "Vehicle", "gl")) ?? 0) - 0.25) < 0.02);
  ok("missing months in the same GL still show (partial); 15/18-month ledgers and bonuses keep their period; a line is placed in its own upload");
}

// ── F2-05: a portion named with its whole account ───────────────────────────────
{
  const rent = monthly(5000, 2024, 12, 1, "Rent", "gl");
  const all = new Set(rent.map((_, i) => i));
  const r = settleDiscovered({ label: "Above-market rent to related party", category: "related_party", annualAmount: 12000, accounts: ["Rent"],
    matchedTransactionIndices: rent.map((_, i) => i) }, rent, all);
  assert.equal(r.annualAmount, 12000);
  assert.equal(r.verificationStatus, "exceeds_claim");
  assert.equal(evidencedAmount(r as never), 12000);
  // A portion named with its account in words ("personal use (50%)") too.
  const veh = monthly(1500, 2024, 12, 1, "Vehicle", "gl");
  const half = settleDiscovered({ label: "Personal use of company vehicle (50%)", category: "discretionary", annualAmount: 9000, accounts: ["Vehicle"],
    matchedTransactionIndices: [] }, veh, new Set(veh.map((_, i) => i)));
  assert.equal(half.annualAmount, 9000);
  assert.equal(half.verificationStatus, "exceeds_claim");
  // An add-back that doesn't say it is a portion is the account, summed in code
  // (the model's lower figure may come from lines it didn't see); near or above its total, too.
  assert.equal(settleDiscovered({ label: "Owner salary", category: "owner_comp", annualAmount: 45000, accounts: ["Owner salary"], matchedTransactionIndices: [] },
    monthly(10000, 2024, 12, 1, "Owner salary", "gl"), new Set([0])).annualAmount, 120000);
  const sal = monthly(10000, 2024, 12, 1, "Owner salary", "gl");
  assert.equal(settleDiscovered({ label: "Owner salary", category: "owner_comp", annualAmount: 100000, accounts: ["Owner salary"], matchedTransactionIndices: [0] }, sal, new Set([0])).annualAmount, 120000);
  assert.equal(settleDiscovered({ label: "Owner salary", category: "owner_comp", annualAmount: 240000, accounts: ["Owner salary"], matchedTransactionIndices: [0] }, sal, new Set([0])).annualAmount, 120000);
  ok("a portion named with its whole account (above-market rent, personal use 50%) keeps the portion; any other named account is the account, summed in code");
}

// ── F2-03: fleet units, lessor forms, makers ────────────────────────────────────
{
  for (const t of [
    "Tractor lease - Unit 14 (2021 Freightliner Cascadia)",
    "Truck lease (Unit #22)",
    "Truck lease - Unit 7",
    "Reefer trailer lease - units 301-306",
    "Forklift lease - unit 3",
    "Equipment lease · Commercial lease agreement",
    "Terminal tractor lease",
    "Mitsubishi Forklift Lease",
    "Lease - 2022 Ford F-150",
    "Lease agreement - 2023 Kenworth T680",
    "Lease - POS terminals (Moneris)",
  ]) assert.ok(isEquipmentLeaseTitle(t), t);
  for (const t of [
    "Lease - Toyota forklift (Unit 4)",
    "Lease - Mississauga Auto Centre (Unit 7)",
    "Lease - Barnston truck terminal",
    "Commercial lease - Bay Truck & Trailer Repair",
    "Lease - Kingsway Auto Body",
    "Lease - fleet garage",
    "Lease - Unit 4",
  ]) assert.ok(isPremisesLeaseTitle(t) && !isEquipmentLeaseTitle(t), t);
  // The merge: a fleet unit's lease never becomes the terminal's lease.
  let info: Record<string, unknown> = mergeExtractedData({}, { leaseExpiry: "August 31, 2031", monthlyRent: "$22,000 per month", leaseAddress: "7700 Barnston Ave, Surrey BC" },
    { source: "document", documentId: "P1", title: "Terminal lease - 7700 Barnston Ave", dated: "2024-01-10" });
  info = mergeExtractedData(info, { _documentType: "Lease agreement", leaseExpiry: "March 31, 2028", monthlyRent: "$2,450 per month" },
    { source: "document", documentId: "E1", title: "Tractor lease - Unit 14 (2021 Freightliner Cascadia)", dated: "2025-03-01" });
  assert.equal(info.leaseExpiry, "August 31, 2031");
  assert.equal(info.monthlyRent, "$22,000 per month");
  assert.match(String(info.vehicleLeases), /Unit 14.*March 31, 2028/);
  ok("a numbered fleet unit, a lessor's 'commercial lease' form and maker / model titles are equipment; a unit beside a description is premises");
}
