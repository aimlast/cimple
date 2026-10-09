/**
 * Interview together — the coverage-board routes (server/routes/together.ts),
 * through a real Express app with in-memory storage and throwing model seams
 * (any model call fails the test). No database, no AI, no email.
 *  - tenancy: no session → 401; another brokerage's deal → 404; the seller
 *    route checks the invite token and returns statuses only;
 *  - GET coverage-board never calls a model and starts nothing; the screen
 *    audience masks a CRM value;
 *  - marks: come back later, a private note, "Seller will send it"; validation;
 *  - ✓ Confirmed: an estimate → on file (confirmed by you); a lead → the
 *    broker vouches for its source; a conflict → 409 resolve; nothing on
 *    file → 409 needs_answer;
 *  - outline writes run under the facts lock (concurrent edits both land).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/routes.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";

process.env.DISABLE_SCHEDULERS = "1";

// ── Any model call fails the test ──────────────────────────────────────
let modelCalls = 0;
const proto = (Anthropic as any).Messages.prototype;
proto.create = function () { modelCalls++; throw new Error("test: a model was called"); };
proto.stream = function () { modelCalls++; throw new Error("test: a model was called"); };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  throw new Error(`test: blocked outbound fetch to ${u}`);
}) as any;

const sources = {
  annualRevenue: { source: "interview" },
  customerConcentration: { source: "crm", documentId: "crm1", brokerOnly: true },
  leaseDetails: { source: "call", documentId: "call1" },
  seasonality: { source: "interview" },
  idealBuyer: { source: "crm", documentId: "crm2" },
};
const deals: Record<string, any> = {
  D1: {
    id: "D1", brokerId: "B1", businessName: "Harbour Heating Ltd", industry: "", subIndustry: null, askingPrice: null,
    interviewPlan: null, interviewOutline: null, sectionImportance: null, interviewEvidence: null,
    extractedInfo: {
      annualRevenue: "about $4.8M",
      customerConcentration: "Top customer 40% (from the broker's CRM)",
      leaseDetails: "Lease to 2029",
      seasonality: "Busy June to August",
      idealBuyer: "A local competitor",
      _fieldSources: sources,
    },
  },
  D2: { id: "D2", brokerId: "B2", businessName: "Other Brokerage Deal", industry: "", extractedInfo: {} },
};
const sessions = [{ id: "S1", dealId: "D1", status: "completed", lastActivityAt: new Date(), startedAt: new Date(), extractedInfo: { _confidenceLevels: { annualRevenue: "approximate" } } }];
const documents = [
  { id: "crm1", dealId: "D1", name: "CRM note — valuation meeting", visibility: "broker_only", sourceKind: "crm" },
  { id: "crm2", dealId: "D1", name: "CRM note — buyer ideas", visibility: "shared", sourceKind: "crm" },
  { id: "call1", dealId: "D1", name: "Discovery call", visibility: "shared", sourceKind: "call" },
];
const discrepancies: any[] = [
  { id: "X1", dealId: "D1", status: "open", source: "merge", factKey: "leaseDetails", factYear: null, field: "Lease", interviewValue: "2029", documentValue: "2027", sideSources: { interview: { kind: "call", documentId: "call1" }, document: { kind: "document" } } },
];
const requirements = [{ id: "R1", dealId: "D1", documentName: "General ledger", isRequired: true, status: "missing", source: "auto" }];
const invites = [{ id: "I1", dealId: "D1", token: "seller-token-1" }];

async function main() {
  const { storage } = await import("../../server/storage");
  const { db } = await import("../../server/db");
  const { registerTogetherRoutes } = await import("../../server/routes/together");
  const { _setMarksStoreForTests } = await import("../../server/together/marks");
  const { patchOutline, getInterviewOutline } = await import("../../server/interview/outline");

  const S = storage as any;
  Object.assign(S, {
    getDeal: async (id: string) => (deals[id] ? structuredClone(deals[id]) : undefined),
    updateDeal: async (id: string, patch: any) => {
      await new Promise((r) => setTimeout(r, 5));
      deals[id] = { ...deals[id], ...patch };
      return structuredClone(deals[id]);
    },
    getSellerInviteByToken: async (t: string) => invites.find((i) => i.token === t),
    getDiscrepanciesByDeal: async (id: string) => discrepancies.filter((d) => d.dealId === id),
    getResolvedDiscrepancies: async (id: string) => discrepancies.filter((d) => d.dealId === id && ["resolved", "accepted", "ask_seller"].includes(d.status)),
    getDocumentRequirementsByDeal: async (id: string) => requirements.filter((r) => r.dealId === id),
  });
  (db as any).select = () => {
    let table: any = null;
    const chain: any = {
      from(t: any) { table = t; return chain; },
      where() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      then(res: any, rej: any) {
        const name = table?.[Symbol.for("drizzle:Name")];
        const rows = name === "documents" ? documents.filter((d) => d.dealId === "D1") : name === "interview_sessions" ? sessions : [];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return chain;
  };
  // Marks in memory.
  const marks: any[] = [];
  let mid = 0;
  _setMarksStoreForTests({
    active: async (dealId) => marks.filter((m) => m.dealId === dealId && !m.clearedAt),
    insert: async (row) => { const r = { id: `M${++mid}`, createdAt: new Date(), clearedAt: null, ...row }; marks.push(r); return r as any; },
    clear: async (dealId, itemId, kind) => {
      let n = 0;
      for (const m of marks) if (m.dealId === dealId && m.itemId === itemId && m.kind === kind && !m.clearedAt) { m.clearedAt = new Date(); n++; }
      return n;
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { brokerId: req.get("x-test-broker") || undefined }; next(); });
  registerTogetherRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, broker: string | null = "B1") => {
    const r = await realFetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(broker ? { "x-test-broker": broker } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json };
  };
  const itemOf = (board: any, id: string) => board.sections.flatMap((s: any) => s.items).find((i: any) => i.id === id);
  let n = 0;
  const ok = (name: string) => { n++; console.log("✓", name); };

  try {
    // ── Tenancy ──
    assert.equal((await call("GET", "/api/deals/D1/coverage-board", undefined, null)).status, 401);
    assert.equal((await call("GET", "/api/deals/D2/coverage-board")).status, 404, "another brokerage's deal");
    assert.equal((await call("POST", "/api/deals/D2/coverage-board/items/seasonality:seasonality/marks", { kind: "verify_later" })).status, 404);
    assert.equal((await call("POST", "/api/deals/D2/coverage-board/items/financials:annualRevenue/confirm", {})).status, 404);
    assert.equal((await call("GET", "/api/deals/D2/coverage-board/items/seasonality:seasonality")).status, 404);
    ok("no session → 401; another brokerage's deal → 404 on every route");

    // ── The board ──
    const before = modelCalls;
    const b1 = await call("GET", "/api/deals/D1/coverage-board");
    assert.equal(b1.status, 200);
    assert.equal(modelCalls, before, "GET coverage-board never calls a model");
    assert.equal(b1.json.audience, "broker");
    assert.equal(itemOf(b1.json, "financials:annualRevenue").reason.code, "estimate");
    assert.equal(itemOf(b1.json, "real_estate:leaseDetails").reason.code, "conflict");
    assert.equal(b1.json.documents[0].name, "General ledger");
    const screen = await call("GET", "/api/deals/D1/coverage-board?audience=screen");
    assert.equal(screen.json.audience, "screen");
    assert.ok(!JSON.stringify(screen.json).includes("from the broker's CRM"), "screen never carries the broker-only value");
    assert.equal(itemOf(screen.json, "revenue_sources:customerConcentration").privateValue, true);
    ok("GET coverage-board: no model call; the screen audience masks a broker-only value");

    // ── Detail ──
    assert.equal((await call("GET", "/api/deals/D1/coverage-board/items/bad id")).status, 400);
    assert.equal((await call("GET", "/api/deals/D1/coverage-board/items/financials:nope")).status, 404);
    const det = await call("GET", "/api/deals/D1/coverage-board/items/real_estate:leaseDetails");
    assert.equal(det.status, 200);
    assert.equal(det.json.fullValue, "Lease to 2029");
    ok("item detail: 400 for a bad id, 404 for an unknown item, the full value otherwise");

    // ── Marks ──
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/marks", { kind: "confirmed" })).status, 400, "the board doesn't set 'confirmed' as a plain mark");
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/marks", { kind: "note", note: "x".repeat(1001) })).status, 400);
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/marks", { kind: "doc_promised" })).status, 400);
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/marks", { kind: "verify_later" })).status, 200);
    let b = (await call("GET", "/api/deals/D1/coverage-board")).json;
    assert.equal(itemOf(b, "seasonality:seasonality").status, "verify");
    assert.equal(itemOf(b, "seasonality:seasonality").reason.code, "marked");
    // Twice → still one active mark.
    await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/marks", { kind: "verify_later" });
    assert.equal(marks.filter((m) => m.itemId === "seasonality:seasonality" && m.kind === "verify_later" && !m.clearedAt).length, 1, "one active mark per item and kind");
    assert.equal((await call("DELETE", "/api/deals/D1/coverage-board/items/seasonality:seasonality/marks/verify_later")).status, 200);
    b = (await call("GET", "/api/deals/D1/coverage-board")).json;
    assert.equal(itemOf(b, "seasonality:seasonality").status, "on_file");
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/marks", { kind: "note", note: "Ask about March" })).status, 200);
    const sScreen = (await call("GET", "/api/deals/D1/coverage-board?audience=screen")).json;
    assert.ok(!JSON.stringify(sScreen).includes("Ask about March"), "a private note never reaches the screen");
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/doc:R1/marks", { kind: "doc_promised" })).status, 200);
    b = (await call("GET", "/api/deals/D1/coverage-board")).json;
    assert.equal(b.documents[0].promised, true);
    ok("marks: come back later (one active row), a private note (never on screen), 'Seller will send it'; validation");

    // ── ✓ Confirmed ──
    const conflict = await call("POST", "/api/deals/D1/coverage-board/items/real_estate:leaseDetails/confirm", {});
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, "resolve");
    assert.equal(conflict.json.discrepancyId, "X1");
    const missing = await call("POST", "/api/deals/D1/coverage-board/items/reason_for_sale:reasonForSale/confirm", {});
    assert.equal(missing.status, 409);
    assert.equal(missing.json.code, "needs_answer");
    const est = await call("POST", "/api/deals/D1/coverage-board/items/financials:annualRevenue/confirm", {});
    assert.equal(est.status, 200);
    assert.equal(itemOf(est.json.board, "financials:annualRevenue").status, "on_file");
    assert.equal(itemOf(est.json.board, "financials:annualRevenue").confirmedByYou, true);
    // A lead the broker confirms: its source is vouched for (acceptedByBroker), no text copied.
    const before2 = JSON.stringify(deals.D1.extractedInfo.idealBuyer);
    const lead = await call("POST", "/api/deals/D1/coverage-board/items/buyer_profile:idealBuyer/confirm", {});
    assert.equal(lead.status, 200);
    assert.equal(deals.D1.extractedInfo._fieldSources.idealBuyer.acceptedByBroker, true);
    assert.equal(deals.D1.extractedInfo._fieldSources.idealBuyer.source, "crm", "the lead keeps its real kind");
    assert.equal(JSON.stringify(deals.D1.extractedInfo.idealBuyer), before2, "no text copied");
    assert.equal(itemOf(lead.json.board, "buyer_profile:idealBuyer").status, "on_file");
    assert.equal(modelCalls, before, "no model call anywhere");
    ok("✓ Confirmed: an estimate → on file (confirmed by you); a lead → its source vouched for, no text copied; a conflict → 409 resolve; nothing on file → 409");

    // ── The seller's "What we've covered" ──
    assert.equal((await call("GET", "/api/seller/wrong-token/coverage", undefined, null)).status, 404);
    const sc = await call("GET", "/api/seller/seller-token-1/coverage", undefined, null);
    assert.equal(sc.status, 200);
    assert.equal(sc.json.audience, "seller");
    for (const it of sc.json.sections.flatMap((s: any) => s.items)) {
      assert.equal(it.value, null);
      assert.equal(it.source, null);
      assert.equal(it.reason, null);
    }
    assert.ok(!JSON.stringify(sc.json).includes("Ask about March") && !JSON.stringify(sc.json).includes("CRM"));
    ok("the seller's coverage: a wrong token → 404; the right one → statuses only");

    // ── Outline writes under the facts lock ──
    deals.D1.interviewOutline = null;
    await Promise.all([
      patchOutline(structuredClone(deals.D1), { removeItems: ["missionStatement", "coreValues"] }),
      patchOutline(structuredClone(deals.D1), { addItem: { sectionKey: "operations", label: "Number of service vans" } }),
    ]);
    const outline = getInterviewOutline(deals.D1);
    assert.deepEqual([...(outline.removedItems ?? [])].sort(), ["coreValues", "missionStatement"], "the removal landed");
    assert.equal(outline.addedItems?.[0]?.label, "Number of service vans", "…and so did the concurrent addition");
    assert.equal(outline.addedItems?.[0]?.origin, "broker");
    const refused = await patchOutline(structuredClone(deals.D1), { removeItems: ["annualRevenue"] });
    assert.match(refused.refused ?? "", /needed in every CIM/);
    ok("outline: concurrent edits both land (facts lock); a board item removes all its members at once; revenue can't be removed");
  } finally {
    server.close();
  }
  console.log(`\n${n} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
