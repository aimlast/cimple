/**
 * Round F (analysis), known-2 (recheck D10): "Failed to parse financial
 * extraction response for 'Email thread — document request & Gord's
 * add-back list': SyntaxError: Unexpected non-whitespace character after
 * JSON at position 4 (line 3 column 1)" — the model answered "[]" and then
 * prose (position 4 = line 3, column 1 after "[]\n\n"), and the fallback
 * parse ran from the first "[" to the LAST "]" in the prose.
 *
 * The extractor runs against a local stand-in for the Messages API
 * (streamed, no network, no paid call) replaying responses of that shape.
 *
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-analysis-extraction.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseJsonLoose, jsonValuesIn } from "../../server/financial/shape";

const STATEMENT = {
  statementType: "income_statement",
  periods: ["2024"],
  lineItems: [{ label: "Owner's truck & personal", amounts: { "2024": 28000 }, category: "operating_expenses" }],
  currency: "CAD",
  confidence: 0.6,
  notes: ["Seller's add-back list, not a statement"],
};

// ── parseJsonLoose on the shapes that failed ──
{
  const d10 = "[]\n\nThis document is an email thread, not a financial statement. Gord's add-back list [truck, hockey, Donna's wage] is covered elsewhere.";
  assert.throws(() => JSON.parse(d10), /after JSON at position 4/, "the recorded failure");
  assert.deepEqual(parseJsonLoose(d10), []);
  // "[]" then the real answer: the substantive value wins.
  assert.deepEqual(parseJsonLoose(`[]\n\nOn reflection, the add-back list is a statement:\n${JSON.stringify([STATEMENT])}`), [STATEMENT]);
  // A fenced object followed by an aside with braces.
  assert.deepEqual(parseJsonLoose("```json\n{\"a\": 1, \"b\": [1, 2]}\n```\nNote: {see above}"), { a: 1, b: [1, 2] });
  // Strings with brackets inside don't confuse the scan.
  assert.deepEqual(parseJsonLoose('Here: {"label": "Rent ]} [2024]", "v": 3} done'), { label: "Rent ]} [2024]", v: 3 });
  assert.equal(jsonValuesIn("no json [here] {or here}").length, 0);
  assert.throws(() => parseJsonLoose("no json at all"), /No JSON found/);
  console.log("✓ known-2: '[]' + prose, '[]' + the real array, fenced JSON + aside all parse");
}

// ── The extractor end to end against a stand-in Messages API (streamed) ──
const replies: string[] = [];
const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const text = replies.shift() ?? "[]";
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 40) send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 40) } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } });
  send("message_stop", { type: "message_stop" });
  res.end();
});

(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "unused-test-key";
  const { extractFinancialData } = await import("../../server/financial/extractor");
  const email = "Email thread — document request & Gord's add-back list\n".repeat(5);
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    // 1. The D10 reply: no statements, and no parse failure logged.
    replies.push("[]\n\nThis document is an email thread with an add-back list [not a statement].");
    assert.deepEqual(await extractFinancialData(email, "doc1", "Email thread — document request & Gord's add-back list"), []);
    assert.equal(errors.length, 0, "no 'Failed to parse' error");
    // 2. "[]" then the real array: the statement is extracted.
    replies.push(`[]\n\nCorrection — it does contain one:\n${JSON.stringify([STATEMENT])}`);
    const got = await extractFinancialData(email, "doc1", "Email thread");
    assert.equal(got.length, 1);
    assert.equal(got[0].sourceDocumentId, "doc1");
    assert.equal(got[0].lineItems[0].amounts["2024"], 28000);
    // 3. A lone statement object (not wrapped in an array) is the same answer.
    replies.push(JSON.stringify(STATEMENT));
    assert.equal((await extractFinancialData(email, "doc2", "P&L")).length, 1);
    replies.push(JSON.stringify({ statements: [STATEMENT, STATEMENT] }));
    assert.equal((await extractFinancialData(email, "doc3", "P&L")).length, 2);
  } finally {
    console.error = origError;
    server.close();
  }
  console.log("✓ known-2: the extractor (streamed, stubbed API) reads '[]'+prose as no statements and '[]'+array as the array — no parse failure");
  console.log("f-analysis-extraction: all passed");
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
