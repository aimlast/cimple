/**
 * gl spec §12.1 tests 6, 19, 30 and the pass-2 end-to-end flow on a real
 * Express app (memory store, no database, no AI, no email):
 *   broker: the panel's data → "Ask the seller…" (only the ticked people) →
 *   the seller: "Yes, that's right", ticks, a T4 for owner pay (amount
 *   checked), a note, "This isn't in my ledger", other costs, the accountant
 *   hand-off, "I can't get my ledger", send with the confirmation →
 *   broker: review, review all that add up, the gate done; waive; the
 *   tie-out accepted; the fiscal-year end changed (rows and links move).
 * And the refusals: attorney / representative / revoked links (403), a
 * broker previewing the seller's page (409, nothing saved), unknown or
 * server-owned body keys (400), another broker (404), another deal's cost.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test, done, fixture } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { applyGlRateLimits, registerGlRoutes } from "../../server/routes/gl";
import { onGlSupportDocumentRead } from "../../server/gl/support-docs";
import { refreshGl } from "../../server/gl/service";

const express = (await import("express")).default;
const B = brightwater({ brokerId: "b1" } as any);
const w = B.w;
const deal = B.deal;
w.invites.push(
  { id: "i-own", dealId: deal.id, token: "tok-owner", sellerEmail: "owner@brightwater.invalid", sellerName: "Dan Brightwater", status: "accepted", createdAt: new Date("2025-01-01") } as any,
  { id: "i-acc", dealId: deal.id, token: "tok-acct", sellerEmail: "books@brightwater.invalid", sellerName: "Priya Shah", status: "sent", createdAt: new Date("2025-01-02") } as any,
  { id: "i-att", dealId: deal.id, token: "tok-atty", sellerEmail: "law@brightwater.invalid", status: "sent", createdAt: new Date("2025-01-03") } as any,
);
w.members.push(
  { id: "m-acc", dealId: deal.id, teamType: "seller", role: "accountant", email: "books@brightwater.invalid", name: "Priya Shah", inviteStatus: "sent", emailNotifications: true } as any,
  { id: "m-att", dealId: deal.id, teamType: "seller", role: "attorney", email: "law@brightwater.invalid", inviteStatus: "sent", emailNotifications: true } as any,
);
await B.readLedger("qbo-classic.csv");

let sessionBroker: string | undefined = "b1";
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).session = { brokerId: sessionBroker }; next(); });
applyGlRateLimits(app);
registerGlRoutes(app);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const asSeller = (fn: () => Promise<any>) => async () => { const s = sessionBroker; sessionBroker = undefined; try { return await fn(); } finally { sessionBroker = s; } };

let panel: any;
await test("the broker's panel: add-backs with cells, the tie-out in words, the gate, recipients with their roles", async () => {
  const r = await call("GET", `/api/deals/${deal.id}/gl`);
  assert.equal(r.status, 200);
  panel = r.json;
  assert.equal(panel.traces.length, 9);
  const vehicle = panel.traces.find((t: any) => t.label === "Owner vehicle expenses");
  assert.equal(vehicle.cells["2024"].words, "Not started");
  assert.deepEqual(vehicle.proposedYears, ["2022", "2023", "2024"]);
  assert.equal(panel.gate.state, "not_requested");
  assert.equal(panel.tieOut.years.length, 3);
  assert.equal(panel.tieOut.years.find((y: any) => y.year === "2023").data.likelyReason, "year_end_entries", "the sample's 2023 lacks the accountant's entries");
  assert.match(panel.tieOut.summary.text, /^2023 differs by \$41,200 — likely the accountant's year-end entries/);
  assert.deepEqual(panel.recipients.map((x: any) => [x.id, x.role]).sort(), [["m-acc", "accountant"]], "the accountant is routed (owner + accountant); the attorney never");
  assert.equal(JSON.stringify(panel.recipients).includes("tok-"), false, "never a seller's token");
  assert.ok(panel.possible.some((p: any) => p.account === "Shareholder Expenses"), "possible add-backs we noticed");
});

await test("refusals: another broker 404; body allowlists 400; a cost of another deal 404", async () => {
  sessionBroker = "b2";
  assert.equal((await call("GET", `/api/deals/${deal.id}/gl`)).status, 404);
  sessionBroker = "b1";
  const t = panel.traces[0];
  assert.equal((await call("PATCH", `/api/deals/${deal.id}/gl/traces/${t.id}`, { computed: {} })).status, 400);
  assert.equal((await call("PATCH", `/api/deals/${deal.id}/gl/traces/${t.id}`, { dealId: "x" })).status, 400);
  assert.equal((await call("POST", `/api/deals/${deal.id}/gl/request`, { traceIds: [t.id], recipients: [], published: true })).status, 400);
  assert.equal((await call("PATCH", `/api/deals/${deal.id}/gl/traces/not-a-trace`, { sellerLabel: "x" })).status, 404);
});

const id = (label: string) => panel.traces.find((t: any) => t.label === label).id;
const sendIds = ["Owner vehicle expenses", "Meals & entertainment (50% personal use estimate)", "Owner compensation (President - Dan Brightwater)", "Employment settlement (one-time)", "Golf club dues", "Related party salary - Emma Brightwater (spouse)"].map(id);

await test("the broker edits what the seller sees, then asks — only the ticked people, the costs marked sent", async () => {
  assert.equal((await call("PATCH", `/api/deals/${deal.id}/gl/traces/${id("Golf club dues")}`, { sellerHint: "The Glen Abbey membership" })).status, 200);
  const r = await call("POST", `/api/deals/${deal.id}/gl/request`, { traceIds: sendIds, recipients: ["m-acc"], message: "Thanks Dan" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.demo, true, "a demo deal records, never emails");
  const tracing = await w.gl.getTracing(deal.id);
  assert.ok(tracing?.requestedAt);
  assert.deepEqual(tracing?.recipients, [{ memberId: "m-acc", inviteId: null, role: "accountant" }]);
  const traces = await w.gl.listTraces(deal.id);
  assert.equal(traces.filter((t) => t.sentAt).length, 6);
  assert.equal(traces.find((t) => t.label === "Excess insurance (owner life insurance)")!.sentAt, null, "private evidence wasn't ticked");
  assert.equal((await call("POST", `/api/deals/${deal.id}/gl/request`, { traceIds: sendIds, recipients: ["i-att"] })).status, 400, "only people the request may reach");
  const remind = await call("POST", `/api/deals/${deal.id}/gl/remind`);
  assert.equal(remind.status, 200);
  assert.equal((await call("POST", `/api/deals/${deal.id}/gl/remind`)).status, 409, "once a day");
});

await test("the seller's links: attorney 403; a broker previewing 409 and nothing saved", async () => {
  const atty = await asSeller(() => call("GET", "/api/seller/tok-atty/gl"))();
  assert.equal(atty.status, 403);
  const before = JSON.stringify(w.gl.data.links);
  const prev = await call("POST", `/api/seller/tok-owner/gl/traces/${id("Owner vehicle expenses")}/confirm-summary`);
  assert.equal(prev.status, 409);
  assert.equal(JSON.stringify(w.gl.data.links), before);
  const view = await call("GET", "/api/seller/tok-owner/gl");
  assert.equal(view.json.preview, true, "the broker's preview reads the page");
});

let seller: any;
await test("the seller's page: six costs with the summary; whitelist only", asSeller(async () => {
  const r = await call("GET", "/api/seller/tok-owner/gl");
  assert.equal(r.status, 200);
  seller = r.json;
  assert.equal(seller.state, "requested");
  assert.equal(seller.costs.length, 6);
  assert.equal(seller.message, "Thanks Dan");
  const golf = seller.costs.find((c: any) => c.sellerLabel === "Golf club dues");
  assert.equal(golf.sellerHint, "The Glen Abbey membership", "the broker's words");
  assert.ok(!JSON.stringify(seller).match(/market salary|ebitda|"label"|"category"|buyerReason|brokerNote/i));
}));

const cost = (label: string) => seller.costs.find((c: any) => c.sellerLabel === label);

await test("'Yes, that's right' confirms every high-confidence entry, every year; the cost is done", asSeller(async () => {
  const v = cost("Owner vehicle expenses");
  assert.ok(v.summary);
  const r = await call("POST", `/api/seller/tok-owner/gl/traces/${v.id}/confirm-summary`);
  assert.equal(r.status, 200);
  assert.ok(r.json.confirmed > 30);
  const t = await w.gl.getTrace(v.id);
  assert.equal(t!.sellerStatus, "done");
  assert.equal((t!.computed as any).byYear["2024"].status, "found");
  assert.equal((t!.computed as any).overall, "found");
}));

await test("ticks: the entries list, a search, add + reject, and the numbers follow", asSeller(async () => {
  const m = cost("Meals & entertainment");
  const e = await call("GET", `/api/seller/tok-owner/gl/entries?trace=${m.id}&fy=2024`);
  assert.equal(e.status, 200);
  assert.ok(e.json.entries.length > 10);
  const add = e.json.entries.slice(0, -1).map((x: any) => ({ ledgerId: x.ledgerId, rowNo: x.rowNo }));
  const last = e.json.entries[e.json.entries.length - 1];
  const r = await call("PUT", `/api/seller/tok-owner/gl/traces/${m.id}/links`, { fy: "2024", add, reject: [{ ledgerId: last.ledgerId, rowNo: last.rowNo }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const t = await w.gl.getTrace(m.id);
  assert.equal((t!.computed as any).byYear["2024"].confirmed, add.length);
  assert.ok(["close", "found", "short"].includes((t!.computed as any).byYear["2024"].status));
  const s = await call("GET", `/api/seller/tok-owner/gl/search?fy=2024&q=Petro-Canada`);
  assert.equal(s.status, 200);
  assert.ok(s.json.rows.length > 0 && s.json.rows.every((x: any) => x.fiscalYear === "2024"));
  assert.equal((await call("GET", `/api/seller/tok-owner/gl/search?min=abc`)).status, 400);
  assert.equal((await call("PUT", `/api/seller/tok-owner/gl/traces/${m.id}/links`, { add: [{ ledgerId: "x", rowNo: 1 }], computed: 1 })).status, 400);
}));

await test("pay: a T4 for 2024 — the typed amount is looked for in the document once it's read", asSeller(async () => {
  const p = cost("Your pay as owner");
  const fd = new FormData();
  fd.append("years", JSON.stringify(["2024"]).replace(/[\[\]"]/g, ""));
  fd.append("amounts", JSON.stringify({ "2024": "240,000" }));
  fd.append("file", new Blob([fs.readFileSync(fixture("t4-2024.txt"))]), "t4-2024.csv");
  const r = await fetch(`${base}/api/seller/tok-owner/gl/traces/${p.id}/support-docs`, { method: "POST", body: fd });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const doc = w.documents.get(j.documentId)!;
  assert.equal(doc.subcategory, "addback_support");
  assert.equal((doc.sourceMeta as any).glTraceId, p.id);
  // The normal reader sets the text; then the check runs.
  doc.extractedText = fs.readFileSync(fixture("t4-2024.txt"), "utf8");
  await onGlSupportDocumentRead(doc.id);
  const t = await w.gl.getTrace(p.id);
  const y = (t!.computed as any).byYear["2024"];
  assert.equal(y.status, "document");
  assert.equal(y.reason, undefined, "found on the document — no broker check needed");
  const bad = await fetch(`${base}/api/seller/tok-owner/gl/traces/${p.id}/support-docs`, { method: "POST", body: (() => { const f = new FormData(); f.append("years", "2019"); f.append("amounts", "{}"); f.append("file", new Blob(["x"]), "a.pdf"); return f; })() });
  assert.equal(bad.status, 400, "a year the broker didn't ask about");
}));

await test("notes, 'not in my ledger', status, done needs every cost and the confirmation", asSeller(async () => {
  const s = cost("Employment settlement");
  assert.equal((await call("POST", `/api/seller/tok-owner/gl/traces/${s.id}/note`, { text: "Half was legal fees", off: true })).status, 200);
  assert.equal((await w.gl.getTrace(s.id))!.sellerStatus, "disputed");
  const g = cost("Golf club dues");
  assert.equal((await call("POST", `/api/seller/tok-owner/gl/traces/${g.id}/not-in-ledger`, { reason: "personal" })).status, 200);
  assert.equal((await w.gl.getTrace(g.id))!.sellerStatus, "not_in_ledger");
  const notYet = await call("POST", "/api/seller/tok-owner/gl/done", { confirm: true });
  assert.equal(notYet.status, 409, "costs still open");
  for (const c of [cost("Meals & entertainment"), cost("Your pay as owner"), cost("Emma Brightwater's pay")]) {
    assert.equal((await call("POST", `/api/seller/tok-owner/gl/traces/${c.id}/status`, { status: "done" })).status, 200);
  }
  assert.equal((await call("POST", "/api/seller/tok-owner/gl/done", {})).status, 400, "the confirmation tick is required");
  const ok = await call("POST", "/api/seller/tok-owner/gl/done", { confirm: true });
  assert.equal(ok.status, 200);
  const tracing = await w.gl.getTracing(deal.id);
  assert.ok(tracing?.sellerDoneAt);
  assert.equal((tracing?.sellerConfirmation as any).role, "owner");
  const after = await call("GET", "/api/seller/tok-owner/gl");
  assert.equal(after.json.state, "waiting_for_broker");
}));

await test("other costs, the accountant hand-off (refuses an email on the deal), can't get the ledger, email me the link (demo)", asSeller(async () => {
  assert.equal((await call("POST", "/api/seller/tok-owner/gl/other-costs", { text: "The business pays my phone" })).status, 200);
  const dup = await call("POST", "/api/seller/tok-owner/gl/accountant", { name: "Law", email: "law@brightwater.invalid" });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, "That email is already on this deal.");
  const acc = await call("POST", "/api/seller/tok-owner/gl/accountant", { name: "Sam Lee", email: "sam@cpa.invalid" });
  assert.equal(acc.status, 200);
  const pending = w.members.find((m) => m.email === "sam@cpa.invalid")!;
  assert.equal(pending.inviteStatus, "pending");
  assert.equal(pending.role, "accountant");
  assert.equal((await call("POST", "/api/seller/tok-owner/gl/cant-get-ledger", { reason: "other" })).status, 400, "say what's happening");
  assert.equal((await call("POST", "/api/seller/tok-owner/gl/cant-get-ledger", { reason: "no_software" })).status, 200);
  const link = await call("POST", "/api/seller/tok-owner/gl/email-me-link");
  assert.equal(link.status, 200);
  assert.equal(link.json.demo, true);
}));

await test("the broker: the accountant's link (or not), review, review all that add up, the gate done", async () => {
  const p = await call("GET", `/api/deals/${deal.id}/gl`);
  assert.equal(p.json.gate.state, "with_broker");
  assert.equal(p.json.suggestions.length, 1);
  assert.equal((p.json.tracing.accountantRequest as any).name, "Sam Lee");
  assert.equal((await call("POST", `/api/deals/${deal.id}/gl/accountant/decline`)).status, 200);
  assert.equal(w.members.some((m) => m.email === "sam@cpa.invalid"), false, "the pending member goes");
  const rf = await call("POST", `/api/deals/${deal.id}/gl/review-found`);
  assert.equal(rf.status, 200);
  assert.ok(rf.json.reviewed >= 1);
  const left = (await call("GET", `/api/deals/${deal.id}/gl`)).json.traces.filter((t: any) => t.proof !== "statement" && !t.reviewedAt && t.includeInCim);
  for (const t of left) {
    const r = await call("POST", `/api/deals/${deal.id}/gl/traces/${t.id}/review`, { verdict: "partly_found", note: "Checked" });
    assert.equal(r.status, 200);
  }
  const done1 = await call("GET", `/api/deals/${deal.id}/gl`);
  assert.equal(done1.json.gate.state, "done");
  assert.ok(done1.json.tracing.reviewedAt);
  assert.equal((await call("POST", `/api/deals/${deal.id}/gl/traces/${left[0].id}/review`, { verdict: "maybe" })).status, 400);
});

await test("the tie-out: accept a difference with a note; the hold switch; waive and undo", async () => {
  assert.equal((await call("PATCH", `/api/deals/${deal.id}/gl/tie-out`, { year: "2023", accept: { note: "" } })).status, 400);
  assert.equal((await call("PATCH", `/api/deals/${deal.id}/gl/tie-out`, { year: "2023", accept: { note: "The accountant's year-end entries" } })).status, 200);
  const p = await call("GET", `/api/deals/${deal.id}/gl`);
  assert.equal(p.json.tieOut.summary.tone, "good");
  assert.equal((await call("PATCH", `/api/deals/${deal.id}/gl/settings`, { requireBeforeCim: true })).status, 200);
  assert.equal((await w.gl.getTracing(deal.id))!.requireBeforeCim, true);
  assert.equal((await call("POST", `/api/deals/${deal.id}/gl/waive`, { reason: "" })).status, 400);
  assert.equal((await call("POST", `/api/deals/${deal.id}/gl/waive`, { reason: "No books kept" })).status, 200);
  assert.equal((await call("DELETE", `/api/deals/${deal.id}/gl/waive`)).status, 200);
});

await test("the fiscal-year end changes: entries, links and the ledger's years move; confirmed ticks kept", async () => {
  const confirmedBefore = w.gl.data.links.filter((k) => k.dealId === deal.id && k.state === "confirmed" && k.ledgerId).length;
  const r = await call("PATCH", `/api/deals/${deal.id}/gl/settings`, { fiscalYearEnd: "03-31" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = w.gl.data.transactions.find((t) => t.dealId === deal.id && t.txnDate === "2024-07-15")!;
  assert.equal(row.fiscalYear, "2025", "July 2024 is in the year ending March 31, 2025");
  const link = w.gl.data.links.find((k) => k.dealId === deal.id && k.txnDate === "2024-02-03" && k.ledgerId);
  if (link) assert.equal(link.fiscalYear, "2024");
  assert.equal(w.gl.data.links.filter((k) => k.dealId === deal.id && k.state === "confirmed" && k.ledgerId).length, confirmedBefore);
  const ledger = (await w.gl.listLedgers(deal.id))[0];
  assert.ok(Object.keys(ledger.years as object).includes("2025"));
  assert.equal(ledger.fiscalYearEndUsed, "03-31");
  assert.equal((await call("PATCH", `/api/deals/${deal.id}/gl/settings`, { fiscalYearEnd: "02-30" })).status, 400);
  await call("PATCH", `/api/deals/${deal.id}/gl/settings`, { fiscalYearEnd: "12-31" });
  void refreshGl;
});

server.close();
cleanup(w);
done("routes / flow");
