/**
 * Round F (analysis): runFinancialAnalysis end to end — real code, an
 * in-memory store, and a local stand-in for the Messages API (streamed; no
 * network, no paid call) that answers the statement extraction and the
 * comprehensive pass with scripted output of the shapes that went wrong:
 *
 *  - known-2: the extraction answers "[]" + prose for an email, a real
 *    array for the statements — no parse failure;
 *  - F-06: "FY2024 P&L.pdf" filed "other" is extracted as a statement;
 *  - known-1: the model's notes/insight state $1,537,000 / 76% while its
 *    add-backs compute $1,552,000 — the stored text ties;
 *  - F-05: a 2025 column only the broker-only interim P&L states is marked
 *    private and left out of the CIM's financials;
 *  - F-07: every document read is recorded with its role;
 *  - F-02 / F-01: "2024 Revenue" gets factYear 2024 ("FY24" from the model).
 *
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-analysis-pipeline.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const STATEMENTS = [{
  statementType: "income_statement", periods: ["2023", "2024"], currency: "CAD", confidence: 0.9, notes: [],
  lineItems: [
    { label: "Revenue", amounts: { "2023": 9_160_000, "2024": 9_815_000 }, category: "revenue" },
    { label: "Cost of sales", amounts: { "2023": 6_412_000, "2024": 6_870_500 }, category: "cogs" },
    { label: "Net income", amounts: { "2023": 779_090, "2024": 896_410 }, category: "net_income", isTotal: true },
  ],
}];

const ANALYSIS = {
  reclassifiedPnl: {
    years: ["2023", "2024", "2025"],
    rows: [
      { name: "Revenue", category: "Revenue", values: { "2023": 9_160_000, "2024": 9_815_000, "2025": 11_200_000 } },
      { name: "Cost of sales", category: "COGS", values: { "2023": 6_412_000, "2024": 6_870_500, "2025": 7_840_000 } },
      { name: "Operating expenses", category: "Operating Expenses", values: { "2023": 1_968_910, "2024": 2_048_090, "2025": 2_340_000 } },
    ],
    notes: [],
  },
  reclassifiedBalanceSheet: null,
  reclassifiedCashFlow: null,
  normalization: {
    metric: "sde", years: ["2023", "2024"], netIncome: { "2023": 779_090, "2024": 896_410 },
    addbacks: [
      { label: "Owner compensation (President)", description: "Management salary per T4", category: "owner_comp", ownerActualComp: { "2023": 180_000, "2024": 180_000 }, marketSalary: 165_000, amounts: { "2023": 180_000, "2024": 180_000 }, confidence: "high", evidence: "statements" },
      { label: "Amortization", category: "other", amounts: { "2023": 286_000, "2024": 312_000 }, confidence: "high", evidence: "statements" },
      { label: "Crane rebuild (one-time)", category: "one_time", amounts: { "2024": 64_000 }, confidence: "high", evidence: "statements" },
    ],
    notes: [
      "2024 Adjusted EBITDA: $896,410 (net income) + $312,000 (amortization) + $64,000 (crane) = $1,272,410.",
      "Adjusted EBITDA has grown from $1,065,090 in 2023 to $1,272,410 in 2024 (19% growth).",
    ],
  },
  workingCapital: null,
  insights: { positive: [{ title: "Earnings growth", detail: "2024 adjusted EBITDA of $1,272,410." }], negative: [] },
  clarifyingQuestions: [],
  discrepancies: [
    { field: "2024 Revenue", factKey: "revenueByYear", factYear: "FY24", sourceA: { source: "Seller interview", value: "$10,400,000" }, sourceB: { source: "FY2024 P&L", value: "$9,815,000" }, severity: "critical", category: "financial", explanation: "The seller quoted a higher figure.", suggestedResolution: "Confirm." },
  ],
  clearedDiscrepancyIds: [],
  aiReasoning: "Used the statements.",
};

const calls: string[] = [];
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  const prompt = String(body.messages?.[0]?.content ?? "");
  let text: string;
  if (/Extract structured financial data/.test(prompt)) {
    const doc = prompt.match(/DOCUMENT NAME: (.*)/)?.[1] ?? "";
    calls.push(`extract:${doc}`);
    text = /P&L/.test(doc) ? JSON.stringify(STATEMENTS) : "[]\n\nThis is an email thread [not a statement]; the add-back list is covered elsewhere.";
  } else {
    calls.push("analysis");
    text = "```json\n" + JSON.stringify(ANALYSIS) + "\n```";
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 500) send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 500) } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", { type: "message_stop" });
  res.end();
});

(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "unused-test-key";
  const { runFinancialAnalysis } = await import("../../server/financial/analyzer");
  const { buildCimFinancials } = await import("../../server/cim/cim-financials");

  const pnlText = "FY2024 P&L\nRevenue 2023 9,160,000 2024 9,815,000\nCost of sales 2023 6,412,000 2024 6,870,500\nNet income 2023 779,090 2024 896,410\nManagement salary 180,000\nAmortization 286,000 312,000\nCrane rebuild 64,000";
  const docs: any[] = [
    { id: "pl24", dealId: "D", name: "FY2024 P&L.pdf", category: "other", isProcessed: true, extractedText: pnlText, extractedData: null, visibility: "shared", sourceKind: "document" },
    { id: "mail", dealId: "D", name: "Email thread — Gord's add-back list", category: "financials", isProcessed: true, extractedText: "Gord: my add-backs are truck $28,000, hockey $12,000 and so on, see the list below for details.", extractedData: null, visibility: "shared", sourceKind: "email" },
    { id: "int25", dealId: "D", name: "2025 interim P&L (from Gord, private)", category: "financials", isProcessed: true, extractedText: "Interim 2025: Revenue 11,200,000; Cost of sales 7,840,000; Operating expenses 2,340,000", extractedData: null, visibility: "broker_only", sourceKind: "document" },
  ];
  const analyses: any[] = [];
  const discrepancies: any[] = [];
  const storage: any = {
    async getDeal() { return { id: "D", businessName: "Ridgeline", industry: "Manufacturing", extractedInfo: { revenueByYear: { "2023": "$9,160,000", "2024": "$9,815,000" } }, questionnaireData: null }; },
    async getDocumentsByDeal() { return docs; },
    async getDiscrepanciesByDeal() { return discrepancies; },
    async getFinancialAnalysesByDeal() { return [...analyses].sort((a, b) => b.version - a.version); },
    async createFinancialAnalysis(row: any) { const r = { id: `fa${analyses.length + 1}`, createdAt: new Date(), ...row }; analyses.push(r); return r; },
    async updateFinancialAnalysis(id: string, p: any) { Object.assign(analyses.find((a) => a.id === id), p); return analyses.find((a) => a.id === id); },
    async createDiscrepancy(row: any) { const r = { id: `d${discrepancies.length + 1}`, createdAt: new Date(), ...row }; discrepancies.push(r); return r; },
    async updateDiscrepancy(id: string, p: any) { Object.assign(discrepancies.find((d) => d.id === id), p); return discrepancies.find((d) => d.id === id); },
  };
  try {
    const id = await runFinancialAnalysis("D", storage);
    const fa = analyses.find((a) => a.id === id);
    assert.equal(fa.status, "completed", fa.aiReasoning);
    // F-06 + known-2: the P&L filed "other" was extracted as a statement; the email's "[]"+prose parsed.
    assert.ok(calls.includes("extract:FY2024 P&L.pdf"), calls.join(", "));
    assert.ok(calls.includes("extract:Email thread — Gord's add-back list"));
    assert.ok(!calls.some((c) => c.includes("interim")), "broker-only files are never extracted as the deal's statements");
    // F-07: every document read, with its role.
    assert.deepEqual(fa.sourceDocumentIds.map((s: any) => [s.id, s.role]), [["pl24", "statements"], ["mail", "statements"], ["int25", "private"]]);
    // known-1: the notes and the insight tie to the add-backs ($15,000 owner excess included).
    const c = fa.normalization.computed;
    assert.equal(c.adjustedEbitda["2024"], 896_410 + 15_000 + 312_000 + 64_000);
    const notes: string[] = fa.normalization.notes;
    assert.ok(!notes.join(" ").includes("1,272,410"), notes.join(" | "));
    assert.ok(notes.some((n) => /^2024 adjusted EBITDA: \$896,410 \(net income\) \+ \$15,000 .* = \$1,287,410\.$/.test(n)), notes.join(" | "));
    assert.ok(notes.includes("Adjusted EBITDA has grown from $1,080,090 in 2023 to $1,287,410 in 2024 (19% growth)."), notes.join(" | "));
    assert.equal(fa.insights.positive[0].detail, "2024 adjusted EBITDA of $1,287,410.");
    assert.match(fa.aiReasoning, /Figures corrected in code/);
    // F-05: the 2025 column rests only on the broker-only interim P&L.
    assert.deepEqual(fa.reclassifiedPnl.privateYears, ["2025"]);
    const fin = buildCimFinancials(fa)!;
    assert.deepEqual(Object.keys(fin.pnl!), ["2023", "2024"]);
    // F-01 / F-02: the model's "FY24" is the year 2024.
    assert.equal(discrepancies.length, 1);
    assert.equal(discrepancies[0].factKey, "revenueByYear");
    assert.equal(discrepancies[0].factYear, "2024");
    console.log("✓ pipeline: statements read from an 'other' P&L, '[]'+prose parsed, notes tie ($1,287,410), 2025 private column held, roles recorded, FY24 → 2024");
  } finally {
    server.close();
  }
  console.log("f-analysis-pipeline: all passed");
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
