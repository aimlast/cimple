/**
 * "Seller can see this screen" covers every reply, not just the board reads
 * (specs/together.md D10, §10): with the toggle on, the item-action replies
 * (✓ Confirmed, the broker's call note "What did the seller say?", its
 * refusals) never carry a broker-only value — no board in the broker audience,
 * no Undo snapshot (the replaced value, its source, its alternates).
 * Also: a mark records a session only when it is this deal's own.
 * A real Express app, in-memory storage, no AI, blocked outbound fetches.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/screen-responses.test.ts
 */
import { counters, install, lakeshoreDeal, newWorld, statementDoc } from "./harness";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

const CRM_VALUE = "Largest customer about 20% (from the CRM)";

async function main() {
  const w = newWorld();
  w.deals.D1 = lakeshoreDeal();
  w.deals.D2 = { ...lakeshoreDeal("D2"), brokerId: "B2", businessName: "Other Brokerage" };
  w.documents.push(statementDoc());
  await install(w);
  const { registerTogetherRoutes } = await import("../../server/routes/together");

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { brokerId: req.get("x-test-broker") || undefined }; next(); });
  registerTogetherRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, broker: string | null = "B1") => {
    const r = await fetch(url + p, { method, headers: { "content-type": "application/json", ...(broker ? { "x-test-broker": broker } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json, text };
  };
  let n = 0;
  const ok = (name: string) => { n++; console.log("✓", name); };
  const noBrokerValue = (text: string, label: string) => {
    assert.ok(!text.includes(CRM_VALUE), `${label}: the broker's CRM value is not in the reply`);
    assert.ok(!text.includes("Dave K."), `${label}: no broker-only value`);
    assert.ok(!/"crm"|CRM1|brokerOnly|alternates|"before"|"after"/.test(text), `${label}: no source, alternates or Undo snapshot`);
  };

  try {
    // In person: "Seller can see this screen" is on by default.
    const start = await call("POST", "/api/deals/D1/together/sittings", { via: "person" });
    const sid = start.json.sitting.id;
    assert.equal(start.json.sitting.sellerSeesScreen, true);
    assert.equal(start.json.board.audience, "screen");
    noBrokerValue(JSON.stringify(start.json), "start");
    await call("POST", `/api/deals/D1/together/sittings/${sid}/consent`, {});

    // ✓ Confirmed on a CRM lead (no seller words to file → "confirmed by you").
    const confirmed = await call("POST", "/api/deals/D1/coverage-board/items/revenue_sources:customerConcentration/confirm", { sittingId: sid });
    assert.equal(confirmed.status, 200, confirmed.text);
    noBrokerValue(confirmed.text, "confirm");
    assert.equal(confirmed.json.board, undefined);
    ok("✓ Confirmed with the seller's screen on: no broker board in the reply");

    // The broker's call note over the CRM value: written, the CRM value kept as an alternate — but not in the reply.
    const note = await call("POST", "/api/deals/D1/coverage-board/items/revenue_sources:customerConcentration/answer", {
      sittingId: sid, mode: "note", memberKey: "customerConcentration", value: "Biggest customer is the property group, roughly a fifth of sales",
    });
    assert.equal(note.status, 200, note.text);
    assert.equal(note.json.filed, true);
    noBrokerValue(note.text, "call note");
    assert.equal(note.json.result, undefined, "no Undo snapshots in the reply");
    // (The CRM value really was kept beside it on the deal — the reply just doesn't carry it.)
    const fact = w.deals.D1.extractedInfo;
    assert.equal(fact.customerConcentration, "Biggest customer is the property group, roughly a fifth of sales");
    assert.ok(JSON.stringify(fact).includes(CRM_VALUE), "the CRM value is kept as an alternate on the deal");
    ok("the broker's call note with the screen on: filed; the reply holds no snapshot, source or alternate");

    // A refused note (a treatment call) → 422 with a plain message and a code only.
    const refused = await call("POST", "/api/deals/D1/coverage-board/items/revenue_sources:customerConcentration/answer", {
      sittingId: sid, mode: "note", memberKey: "customerConcentration", value: "Add back the owner's personal truck lease as a normalisation add-back",
    });
    if (refused.status === 422) {
      assert.deepEqual(Object.keys(refused.json).sort(), ["code", "error"]);
      noBrokerValue(refused.text, "refused note");
    } else {
      assert.equal(refused.status, 200, refused.text);
      noBrokerValue(refused.text, "note");
    }
    ok("a refused note's reply carries a message and a code only");

    // Marks: a session is recorded only when it is this deal's own.
    const other = await call("POST", "/api/deals/D2/together/sittings", { via: "person" }, "B2");
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/doc:R9/marks", { kind: "doc_promised", sittingId: other.json.sitting.id })).status, 200);
    assert.equal(w.marks.find((m) => m.itemId === "doc:R9" && !m.clearedAt)?.sittingId, null, "another deal's session is never recorded");
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/doc:R8/marks", { kind: "doc_promised", sittingId: "not a session id!" })).status, 200);
    assert.equal(w.marks.find((m) => m.itemId === "doc:R8" && !m.clearedAt)?.sittingId, null);
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/doc:R7/marks", { kind: "doc_promised", sittingId: sid })).status, 200);
    assert.equal(w.marks.find((m) => m.itemId === "doc:R7" && !m.clearedAt)?.sittingId, sid, "this deal's own session is recorded");
    ok("marks record a session only when it is this deal's own");

    assert.equal(counters.modelCalls, 0, "no model call");
  } finally {
    server.close();
  }
  console.log(`\n${n} screen-reply checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
