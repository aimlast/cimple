/**
 * gl spec §12.1 test 14 (§7.4): Cimple's assistant ranking entries, with a
 * stubbed model (no paid AI). Never trusted as is:
 *   - references outside the shortlist are dropped;
 *   - a whole-account pick expands in code to that account's entries;
 *   - totals come from code (the model's numbers are ignored);
 *   - picks are proposals ("Cimple's assistant: …"), never confirmed; a
 *     rejected entry is never proposed again; a seller's tick wins;
 *   - malformed / no tool call / an overload → the rules' proposals stand,
 *     with the plain line;
 *   - the budget is enforced;
 *   - only seller-visible ledgers' rows reach the model.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { refreshGl } from "../../server/gl/service";
import { _setGlAiClientForTests, GL_AI_CAPS } from "../../server/gl/ai";
import { rankWithAi, glAssistantState, picksToProposals, ASSISTANT_WORDS, assistantWords } from "../../server/gl/rank-ai";
import { proposeForTraces } from "../../server/gl/match-run";
import { writeLinks } from "../../server/gl/links";
import { loadGlContext } from "../../server/gl/context";

const B = brightwater();
const dealId = B.deal.id;
const sellerDoc = await B.readLedger("qbo-classic.csv");
// A second ledger, private to the broker (its rows must never reach the model for the seller's cost).
await B.readLedger("payroll-provider.csv", { visibility: "broker_only", uploadedBy: "broker" } as any);
await refreshGl(dealId, { force: true });
const store = B.w.gl;
const traces = new Map((await store.listTraces(dealId)).filter((t) => !t.removedAt).map((t) => [t.label, t]));
const golf = traces.get("Golf club dues")!;
await store.updateTrace(golf.id, { sentAt: new Date() } as any);
const sellerLedger = (await store.getLedgerByDocument(sellerDoc.id))!;

let calls: any[] = [];
let answer: (req: any) => any = () => ({ content: [] });
_setGlAiClientForTests({ messages: { create: async (req: any) => { calls.push(req); return answer(req); } } });

const duesKey = (await store.accountTotals(sellerLedger.id)).find((a) => /dues/.test(a.accountKey))!.accountKey;
const proposalsOf = async (traceId: string) => (await store.linksOfTrace(traceId)).filter((k) => k.state === "proposed");

await test("picks become proposals; refs outside the shortlist dropped; the model's numbers ignored; nothing confirmed", async () => {
  calls = [];
  // Clear the rules' proposals so the assistant's are visible.
  await store.replaceProposals(golf.id, ["2022", "2023", "2024"], []);
  answer = (req) => {
    const refs = Array.from(String(req.messages[0].content).matchAll(/\[(T\d+)\][^\n]*Glen Abbey/g)).map((m) => m[1]);
    return { content: [{ type: "tool_use", name: "pick_ledger_entries", input: { picks: [...refs.slice(0, 3).map((ref) => ({ ref, fit: "yes", reason: "Golf club dues" })), { ref: "T999", fit: "yes" }, { ref: refs[3], fit: "maybe", reason: "probably" }], note: "total is $1,000,000" } }] };
  };
  await rankWithAi({ dealId, traceId: golf.id, years: ["2024"], ai: "broker" });
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.tool_choice.name, "pick_ledger_entries");
  assert.equal(req.temperature, 0);
  assert.ok(!/Payroll — Wagepoint|Wagepoint/.test(req.messages[0].content), "a broker-private ledger's rows never reach the model");
  const props = await proposalsOf(golf.id);
  assert.equal(props.length, 4, "3 yes + 1 maybe; T999 dropped");
  assert.ok(props.every((k) => k.proposedBy === "ai" && /^Cimple's assistant: /.test(k.reason ?? "")));
  assert.equal(props.filter((k) => k.confidence === "medium").length, 3);
  assert.equal(props.filter((k) => k.confidence === "low").length, 1);
  assert.ok(props.every((k) => k.ledgerId === sellerLedger.id));
  assert.equal((await store.linksOfTrace(golf.id)).filter((k) => k.state === "confirmed").length, 0, "never confirmed");
  assert.equal(glAssistantState(golf.id)?.state, "done");
  assert.equal(assistantWords(glAssistantState(golf.id)), "Cimple's assistant suggested 4 more entries.");
  const t = (await store.getTrace(golf.id))!;
  assert.equal((t.computed as any).byYear["2024"].foundCents, 0, "totals come from confirmed entries in code");
});

await test("a whole-account pick expands to that account's entries for the year", async () => {
  await store.replaceProposals(golf.id, ["2022", "2023", "2024"], []);
  answer = (req) => {
    const acc = String(req.messages[0].content).match(/\[(A\d+)\] 2024 · Dues & Memberships/);
    return { content: [{ type: "tool_use", name: "pick_ledger_entries", input: { picks: [], wholeAccounts: acc ? [{ ref: acc[1], fit: "yes" }] : [] } }] };
  };
  await rankWithAi({ dealId, traceId: golf.id, years: ["2024"], ai: "broker" });
  const props = await proposalsOf(golf.id);
  const rows = await store.accountRows(dealId, [sellerLedger.id], "2024", [duesKey]);
  assert.ok(rows.length > 0, "the fixture has the account");
  assert.equal(props.length, rows.length);
  assert.ok(props.every((k) => /whole Dues & Memberships account/.test(k.reason ?? "")));
});

await test("a rejected entry is never proposed again; a seller's tick made meanwhile wins", async () => {
  await store.replaceProposals(golf.id, ["2022", "2023", "2024"], []);
  const c = await loadGlContext(dealId);
  const rows = await store.accountRows(dealId, [sellerLedger.id], "2024", [duesKey]);
  await writeLinks(golf, { fy: "2024", reject: [{ ledgerId: rows[0].ledgerId, rowNo: rows[0].rowNo }], add: [{ ledgerId: rows[1].ledgerId, rowNo: rows[1].rowNo }] }, { by: "seller", memberId: null }, c);
  answer = (req) => {
    const refs = Array.from(String(req.messages[0].content).matchAll(/\[(T\d+)\]/g)).map((m) => m[1]);
    return { content: [{ type: "tool_use", name: "pick_ledger_entries", input: { picks: refs.map((ref) => ({ ref, fit: "yes" })), wholeAccounts: [{ ref: "A1", fit: "yes" }] } }] };
  };
  await rankWithAi({ dealId, traceId: golf.id, years: ["2024"], ai: "broker" });
  const links = await store.linksOfTrace(golf.id);
  const first = links.find((k) => k.ledgerId === rows[0].ledgerId && k.rowNo === rows[0].rowNo)!;
  const second = links.find((k) => k.ledgerId === rows[1].ledgerId && k.rowNo === rows[1].rowNo)!;
  assert.equal(first.state, "rejected", "still rejected");
  assert.equal(second.state, "confirmed", "the seller's tick stands");
  const prompt = calls[calls.length - 1].messages[0].content as string;
  assert.ok(!prompt.includes(`] ${rows[0].txnDate} | Dues & Memberships | ${rows[0].name} | ${rows[0].memo ?? ""} | ${(rows[0].amountCents / 100).toFixed(2)}`), "a rejected entry isn't on the shortlist");
});

await test("malformed answer, no tool call, an overload → the rules' proposals stand, with the plain line", async () => {
  await refreshGl(dealId, { force: true });
  await proposeForTraces(dealId, [golf.id], { ai: "none", force: true });
  const before = (await proposalsOf(golf.id)).length;
  for (const a of [
    () => ({ content: [{ type: "text", text: "Here are the entries" }] }),
    () => ({ content: [{ type: "tool_use", name: "pick_ledger_entries", input: { nope: true } }] }),
    () => { throw Object.assign(new Error("overloaded"), { status: 529 }); },
  ]) {
    answer = a;
    await rankWithAi({ dealId, traceId: golf.id, years: ["2024"], ai: "broker" });
    assert.equal(glAssistantState(golf.id)?.state, "failed");
    assert.equal(assistantWords(glAssistantState(golf.id)), ASSISTANT_WORDS.failed);
    assert.equal((await proposalsOf(golf.id)).length, before);
  }
});

await test("the budget is enforced: past the cap, no call and the 'done its share' line", async () => {
  calls = [];
  answer = () => ({ content: [{ type: "tool_use", name: "pick_ledger_entries", input: { picks: [] } }] });
  const tr = (await store.getTracing(dealId)) as any;
  tr.aiDay = new Date().toISOString().slice(0, 10);
  tr.aiSellerRanking = GL_AI_CAPS.seller_ranking;
  await rankWithAi({ dealId, traceId: golf.id, years: ["2024"], ai: "seller" });
  assert.equal(calls.length, 0);
  assert.equal(glAssistantState(golf.id)?.state, "budget");
  assert.equal(assistantWords(glAssistantState(golf.id)), ASSISTANT_WORDS.budget);
});

await test("no key → never called; the line says the assistant isn't available", async () => {
  _setGlAiClientForTests(null);
  calls = [];
  await rankWithAi({ dealId, traceId: golf.id, years: ["2024"], ai: "broker" });
  assert.equal(calls.length, 0);
  assert.equal(glAssistantState(golf.id)?.state, "unavailable");
});

await test("pure: picksToProposals drops unknown refs and skips decided entries", () => {
  const list = {
    entries: [{ ref: "T1", ledgerId: "L", rowNo: 1, fiscalYear: "2024", txnDate: "2024-01-01", account: "A", name: null, memo: null, amountCents: 100 } as any],
    accounts: [],
  };
  const out = picksToProposals({ picks: [{ ref: "T1", fit: "yes" }, { ref: "T2", fit: "yes" }, { ref: "T1", fit: "nope" }] }, list, new Map(), { id: "t", dealId: "d" }, new Set());
  assert.equal(out.length, 1);
  assert.equal(picksToProposals({ picks: [{ ref: "T1", fit: "yes" }] }, list, new Map(), { id: "t", dealId: "d" }, new Set(["L:1"])).length, 0);
  assert.deepEqual(picksToProposals(null, list, new Map(), { id: "t", dealId: "d" }, new Set()), []);
});

_setGlAiClientForTests(undefined);
cleanup(B.w);
done("assistant ranking (stubbed)");
