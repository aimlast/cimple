/**
 * gl spec §12.1 #24 (fixer round 1, GL-R1-10): through the real Express
 * routes, the generation entry points answer 409 `gl_trace_required` while
 * "Add-backs in the books" holds them:
 *   POST /generate-dd        — the due-diligence CIM waits for the review (D16)
 *   POST /generate-content   — only with "Hold the whole CIM until this is done"
 *   POST /generate-layout    — the same hold (startCimGeneration)
 * In-memory storage and GL store; no database, no AI, no email.
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { test, done } from "./_harness";

process.env.DISABLE_SCHEDULERS = "1";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, init);
  throw new Error(`test: blocked outbound fetch to ${url}`);
}) as any;

const Anthropic = (await import("@anthropic-ai/sdk")).default as any;
Anthropic.Messages.prototype.create = async () => { throw new Error("test: no model call expected"); };
Anthropic.Messages.prototype.stream = () => { throw new Error("test: no model call expected"); };

const { storage } = await import("../../server/storage");
const { brightwater } = await import("./_brightwater");
const { refreshGl } = await import("../../server/gl/service");
const { registerRoutes } = await import("../../server/routes");

// The fictional Brightwater deal: its analysis gives the add-backs (memory store).
const B = brightwater({ brokerId: "B1", interviewCompleted: true, demoKey: "qa-demo", phase: "phase3_content_creation", blindCodename: "Project Tide" } as any);
const gl = B.w.gl;
const deal = B.deal;
Object.assign(storage as any, {
  getUser: async (id: string) => (id === "B1" ? { id: "B1", role: "broker", username: "b", name: "Broker", settings: {} } : undefined),
  getDiscrepanciesByDeal: async () => [],
  getCimSectionsByDeal: async () => [{ id: "s1", dealId: deal.id, sectionKey: "financialOverview", sectionTitle: "Financial Overview", order: 1, layoutType: "financial_table", layoutData: {}, isVisible: true }],
});
await refreshGl(deal.id, { force: true });
// The broker sent the costs to the seller; none is reviewed yet.
await gl.updateTracing(deal.id, { requestedAt: new Date(), requireBeforeCim: false } as any);
const needProof = (await gl.listTraces(deal.id)).filter((t) => !t.removedAt && t.proof !== "statement");
for (const t of needProof) await gl.updateTrace(t.id, { sentAt: new Date() } as any);
const N = needProof.length;

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.session = { brokerId: req.get("x-test-broker") || undefined, save: (cb: any) => cb?.(), regenerate: (cb: any) => cb?.(), destroy: (cb: any) => cb?.() };
  next();
});
const server = await registerRoutes(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = async (p: string, broker = "B1") => {
  const r = await realFetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-test-broker": broker }, body: "{}" });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, json, text };
};

await test("generate-dd: held while add-backs wait for the broker's review — 409 gl_trace_required with the gate", async () => {
  const r = await post(`/api/deals/${deal.id}/generate-dd`);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, "gl_trace_required");
  assert.match(r.json.error, new RegExp(`Finish 'Add-backs in the books' first \\(${N} of ${N} to go\\)`));
  assert.equal(r.json.gate.holdsDd, true);
});

await test("generate-content and generate-layout: 409 gl_trace_required only with the hold switch on", async () => {
  await gl.updateTracing(deal.id, { requireBeforeCim: true } as any);
  for (const p of [`/api/deals/${deal.id}/generate-content`, `/api/deals/${deal.id}/generate-layout`]) {
    const r = await post(p);
    assert.equal(r.status, 409, `${p}: ${r.text}`);
    assert.equal(r.json.code, "gl_trace_required", p);
    assert.match(r.json.error, new RegExp(`hold the CIM until the add-backs are shown in the books \\(${N} to go\\)`), p);
    assert.equal(r.json.gate.holdsCim, true);
  }
});

await test("another brokerage's request never reaches the gate (404)", async () => {
  assert.equal((await post(`/api/deals/${deal.id}/generate-dd`, "B2")).status, 404);
  assert.equal((await post(`/api/deals/${deal.id}/generate-content`, "B2")).status, 404);
});

await test("reviewed (or gone ahead without the ledger) → the DD hold lifts; the CIM hold too", async () => {
  const { glTraceGate, assertGlGate } = await import("../../server/gl/gate");
  for (const t of needProof) await gl.updateTrace(t.id, { reviewedAt: new Date(), brokerVerdict: "found" } as any);
  const g = await glTraceGate(deal.id);
  assert.equal(g.state, "done");
  await assertGlGate(deal, "dd");
  await assertGlGate(deal, "cim");
});

server.close();
const { cleanup } = await import("./_fake-storage");
cleanup(B.w);
done("routes: generation gate");
