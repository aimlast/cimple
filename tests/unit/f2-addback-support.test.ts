// SECOND free round, stream "finance-facts": add-back verification, proved offline
// with a stubbed model client (no API call).
//  F2-04  a partial match stays "partial_match" with the supported total worked out in code;
//         only the supported part counts as verified; the DD CIM says claimed vs supported
//  F2-05  a long ledger: the transactions that could support each add-back are sent (not the
//         first 2,000 lines); a ledger not fully read never yields "no_match"; discovery sees
//         every account; long PDF statements are parsed in pieces
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-addback-support.test.ts
import assert from "node:assert/strict";
import {
  _setAddbackClientForTests,
  identifyAddbacksFromTransactions,
  matchAddbacksToTransactions,
  parseTransactionDataWithCoverage,
  selectCandidateTransactions,
  MAX_TRANSACTIONS_PER_CALL,
  PARSE_CHUNK_CHARS,
  MAX_PARSE_CHUNKS,
  type ParsedTransaction,
} from "../../server/financial/addback-verifier";
import { addbackEvidenceLine, addbackSupport, evidencedAmount, withEvidence } from "../../shared/addback-support";

const ok = (msg: string) => console.log(`✓ ${msg}`);

type Call = { system: string; user: string };
function stub(reply: (call: Call) => string | { text: string; stop?: string }): Call[] {
  const calls: Call[] = [];
  _setAddbackClientForTests({
    messages: {
      create: async (params: any) => {
        const call = { system: String(params.system ?? ""), user: String(params.messages?.[0]?.content ?? "") };
        calls.push(call);
        const r = reply(call);
        const text = typeof r === "string" ? r : r.text;
        return { content: [{ type: "text", text }], stop_reason: typeof r === "string" ? "end_turn" : r.stop ?? "end_turn" };
      },
    },
  });
  return calls;
}

const tx = (date: string, description: string, amount: number, account: string, category = "other"): ParsedTransaction =>
  ({ date, description, amount, account, category, source: "gl", rawLine: "" });

/** Indices of the lines in a prompt whose text matches `re` ("[123] …"). */
function indicesIn(prompt: string, re: RegExp): number[] {
  return prompt.split("\n").filter((l) => /^\[\d+\]/.test(l) && re.test(l)).map((l) => Number(l.match(/^\[(\d+)\]/)![1]));
}

(async () => {
  // ── F2-04: a $60,000 vehicle add-back with $12,000 of vehicle charges ─────────
  const vehicleAb = { id: "ab_v", label: "Personal vehicle", description: "Owner's personal vehicle run through the business", category: "discretionary", annualAmount: 60_000, yearAmounts: { "2024": 60_000 } };
  const salaryAb = { id: "ab_s", label: "Owner salary", description: "Above-market owner salary", category: "owner_comp", annualAmount: 180_000, yearAmounts: { "2024": 180_000 } };
  const small: ParsedTransaction[] = [];
  for (let m = 1; m <= 8; m++) small.push(tx(`2024-${String(m).padStart(2, "0")}-15`, "Fuel & repairs - F150", 1_500, "5300 Vehicle expense", "vehicle"));
  for (let m = 1; m <= 12; m++) small.push(tx(`2024-${String(m).padStart(2, "0")}-28`, "Salary - J. Smith", 15_000, "6120 Management salaries", "payroll"));
  // The model calls the vehicle "matched" and gives its own (wrong) total.
  stub(({ user }) => JSON.stringify([
    { addbackId: "ab_v", verificationStatus: "matched", matchedTransactionIndices: indicesIn(user, /F150/), totalMatchedAmount: 60_000, aiNotes: "Vehicle charges found." },
    { addbackId: "ab_s", verificationStatus: "matched", matchedTransactionIndices: indicesIn(user, /Salary - J\. Smith/), totalMatchedAmount: 180_000, aiNotes: "Monthly salary." },
  ]));
  const [v, sal] = await matchAddbacksToTransactions([vehicleAb, salaryAb], small, "HVAC", "doc1");
  assert.equal(v.verificationStatus, "partial_match");
  assert.equal(v.totalMatchedAmount, 12_000);
  assert.equal(v.claimedAmount, 60_000);
  assert.match(v.aiNotes, /\$12,000 against \$60,000/);
  assert.equal(sal.verificationStatus, "matched");
  assert.equal(sal.totalMatchedAmount, 180_000);
  ok("a $60,000 claim with $12,000 of charges is partly supported, whatever the model called it; the salary matches");

  const stored = { ...vehicleAb, verificationStatus: v.verificationStatus, matchedTransactions: v.matchedTransactions, totalMatchedAmount: v.totalMatchedAmount, claimedAmount: v.claimedAmount };
  assert.equal(evidencedAmount(stored), 12_000);
  assert.equal(evidencedAmount({ ...stored, verificationStatus: "seller_confirmed", previousStatus: "partial_match" }), 12_000);
  assert.equal(evidencedAmount({ ...salaryAb, verificationStatus: "matched" }), 180_000);
  assert.equal(evidencedAmount({ ...salaryAb, verificationStatus: "seller_confirmed", previousStatus: "no_match" }), 180_000);
  assert.equal(evidencedAmount({ ...salaryAb, verificationStatus: "no_match" }), 0);
  const line = addbackEvidenceLine(stored);
  assert.match(line, /partly supported/);
  assert.match(line, /\$60,000 claimed/);
  assert.match(line, /ledger shows \$12,000 \(8 supporting transactions\)/);
  assert.doesNotMatch(line, /\bmatched\b/);
  // A row saved the old way (partial stored as "matched", no total) is read from its own transactions.
  const legacy = { ...vehicleAb, verificationStatus: "matched", matchedTransactions: v.matchedTransactions };
  assert.equal(withEvidence(legacy).verificationStatus, "partial_match");
  assert.match(addbackEvidenceLine(legacy), /partly supported/);
  const legacyConfirmed = withEvidence({ ...legacy, verificationStatus: "seller_confirmed", previousStatus: "matched" });
  assert.equal(legacyConfirmed.previousStatus, "partial_match");
  assert.match(addbackEvidenceLine(legacyConfirmed), /confirmed by the seller, but only partly supported/);
  ok("verified amount counts only the supported $12,000; the DD line says claimed vs supported (older rows too)");

  // Two years of monthly salary against a per-year claim: matched, not "double".
  const twoYears = [...Array(24)].map((_, i) => tx(`${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-28`, "Salary", 15_000, "Mgmt"));
  assert.equal(addbackSupport({ annualAmount: 180_000, yearAmounts: { "2023": 180_000, "2024": 180_000 } }, twoYears).status, "matched");
  assert.equal(addbackSupport({ annualAmount: 180_000 }, twoYears).status, "matched");
  // A June year-end: Jul 2023–Jun 2024 is one year.
  const juneYe = [...Array(12)].map((_, i) => tx(`${i < 6 ? 2023 : 2024}-${String(((i + 6) % 12) + 1).padStart(2, "0")}-28`, "Salary", 15_000, "Mgmt"));
  assert.equal(addbackSupport({ annualAmount: 180_000, yearAmounts: { "2024": 180_000 } }, juneYe).status, "matched");
  ok("support is compared with the claim over the period the transactions span (two years; a June year-end)");

  // ── F2-05: the owner's salary sits at line ~7,400 of a 9,000-line GL ─────────
  const gl: ParsedTransaction[] = [];
  for (let i = 0; i < 7_400; i++) gl.push(tx(`2024-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`, `Materials PO ${i}`, 250 + (i % 50), "5100 Cost of materials", "other"));
  const salaryStart = gl.length;
  for (let m = 1; m <= 12; m++) gl.push(tx(`2024-${String(m).padStart(2, "0")}-28`, "Payroll - J. Smith", 15_000, "6120 Management salaries", "payroll"));
  for (let i = 0; i < 1_588; i++) gl.push(tx(`2024-${String((i % 12) + 1).padStart(2, "0")}-10`, `Wages run ${i}`, 900, "6100 Shop wages", "payroll"));
  assert.ok(gl.length > MAX_TRANSACTIONS_PER_CALL);
  let sent = 0;
  const calls = stub(({ user }) => {
    sent = user.split("\n").filter((l) => /^\[\d+\]/.test(l)).length;
    return JSON.stringify([{ addbackId: "ab_s", verificationStatus: "matched", matchedTransactionIndices: indicesIn(user, /J\. Smith/), totalMatchedAmount: 180_000, aiNotes: "" }]);
  });
  const [owner] = await matchAddbacksToTransactions([{ ...salaryAb, label: "Owner management salary" }], gl, "HVAC", "gl");
  assert.equal(calls.length, 1);
  assert.ok(sent <= MAX_TRANSACTIONS_PER_CALL, `sent ${sent}`);
  assert.ok(indicesIn(calls[0].user, /J\. Smith/).every((i) => i >= salaryStart), "real indices kept");
  assert.equal(indicesIn(calls[0].user, /J\. Smith/).length, 12);
  assert.equal(owner.verificationStatus, "matched");
  assert.equal(owner.totalMatchedAmount, 180_000);
  assert.equal(owner.matchedTransactions[0].description, "Payroll - J. Smith");
  ok("a 9,000-line GL: the management-salary account at line 7,400 is sent (≤2,000 lines, real indices) and matches");

  // An add-back whose likely transactions are more than one call holds: never "no_match".
  const wages: ParsedTransaction[] = [...Array(5_000)].map((_, i) => tx("2024-03-01", `Wages ${i}`, 900, "6100 Wages", "payroll"));
  const famAb = { id: "w", label: "Family member wages", description: "Wages paid to the owner's son", category: "related_party", annualAmount: 52_000, yearAmounts: {} };
  const sel = selectCandidateTransactions([famAb], wages);
  assert.ok(sel.incomplete.has("w"));
  stub(() => JSON.stringify([{ addbackId: "w", verificationStatus: "no_match", matchedTransactionIndices: [], aiNotes: "None found." }]));
  const [w] = await matchAddbacksToTransactions([famAb], wages, "HVAC", "gl");
  assert.equal(w.verificationStatus, "unverified");
  assert.match(w.coverageNote ?? "", /Only 2,000 of the 5,000 transactions/);
  ok("when an add-back's likely transactions can't all be read, it is 'unverified' with a note — not 'no_match'");

  // Discovery sees every account; a named account is summed in full, in code.
  const dcalls = stub(() => JSON.stringify([
    { id: "ab_1", label: "Owner salary", description: "Owner's management salary", category: "owner_comp", annualAmount: 45_000, accounts: ["6120 Management salaries"], matchedTransactionIndices: [], aiNotes: "Seen in account summary." },
    { id: "ab_2", label: "Unlinked", description: "x", category: "other", annualAmount: 5_000, matchedTransactionIndices: [] },
  ]));
  const found = await identifyAddbacksFromTransactions(gl, "HVAC", { businessName: "Test Co" });
  assert.match(dcalls[0].user, /ACCOUNT SUMMARY[\s\S]*6120 Management salaries \| 12 transactions \| total \$180000\.00/);
  assert.ok(indicesIn(dcalls[0].user, /./).length <= MAX_TRANSACTIONS_PER_CALL);
  assert.equal(found[0].annualAmount, 180_000);
  assert.equal(found[0].totalMatchedAmount, 180_000);
  assert.equal(found[0].matchedTransactions.length, 12);
  assert.equal(found[0].verificationStatus, "matched");
  assert.match(found[0].aiNotes, /first estimate was \$45,000/);
  assert.equal(found[1].verificationStatus, "unverified");
  assert.match(found[0].coverageNote ?? "", /were read line by line/);
  ok("discovery on a long GL: every account in a summary; a named account's 12 payments are summed in code ($180,000, not the model's $45,000)");

  // ── F2-05: a long PDF statement is parsed in pieces, not cut at 80,000 characters ──
  const lines = [...Array(3_000)].map((_, i) => `Statement line ${i} ... POS PURCHASE MERCHANT ${i} 12.34`);
  const pdfText = lines.join("\n");
  const pcalls = stub(({ user }) => {
    const first = user.match(/Statement line (\d+)/)?.[1] ?? "0";
    return JSON.stringify([{ date: "2024-01-01", description: `piece from ${first}`, amount: 1, account: "", category: "other", rawLine: "" }]);
  });
  const parsed = await parseTransactionDataWithCoverage(pdfText, "bank", "pdf");
  const expectedPieces = Math.ceil(pdfText.length / PARSE_CHUNK_CHARS);
  assert.ok(expectedPieces <= MAX_PARSE_CHUNKS && expectedPieces > 1);
  assert.ok(pcalls.length >= expectedPieces && pcalls.length <= expectedPieces + 1, `${pcalls.length} calls`);
  assert.equal(parsed.readChars, parsed.totalChars);
  assert.ok(pcalls.some((c) => /Statement line 2999/.test(c.user)), "the last line was read");
  // Longer than the cap: what was read is reported.
  const huge = [...Array(10_000)].map((_, i) => `Statement line ${i} ... POS PURCHASE MERCHANT ${i} 12.34`).join("\n");
  const hcalls = stub(() => "[]");
  const hp = await parseTransactionDataWithCoverage(huge, "bank", "pdf");
  assert.equal(hcalls.length, MAX_PARSE_CHUNKS);
  assert.ok(hp.readChars < hp.totalChars);
  // A reply cut off at its length limit is read again in halves.
  let n = 0;
  stub(({ user }) => (n++ === 0 ? { text: "[{\"date\": \"2024-01-01\", \"desc", stop: "max_tokens" } : JSON.stringify([{ date: "2024-01-01", description: `half ${user.length}`, amount: 1 }])));
  const halves = await parseTransactionDataWithCoverage(lines.slice(0, 200).join("\n"), "bank", "pdf");
  assert.equal(halves.transactions.length, 2);
  ok("a long PDF statement is parsed in pieces (all of it, or what was read is reported); a cut-off reply is re-read in halves");

  console.log("f2-addback-support: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
