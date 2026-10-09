/**
 * gl spec §12.1 tests 29–30 (part): every GL upload is refused BEFORE multer
 * writes a byte when the caller may not upload (a bad or another deal's
 * link, an attorney's or a representative's link, a broker previewing the
 * seller's page, another broker); a declared size over the cap is 413; at
 * most 3 uploads in flight; 20 an hour per IP. The owner's and the
 * accountant's links and the owning broker can upload; the seller's list
 * never shows a ledger private to the broker.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, done, fixture } from "./_harness";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import { _setGlIngestDepsForTests, glQueueIdle } from "../../server/gl/ingest";
import { applyGlRateLimits, registerGlRoutes, glUploadGate, glUploadsInFlight, GL_MAX_IN_FLIGHT, UPLOAD_MESSAGES, GL_UPLOADS_PER_IP_PER_HOUR } from "../../server/routes/gl";

const express = (await import("express")).default;
const w = fakeWorld();
_setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
const deal = fakeDeal(w, { brokerId: "b1" });
const other = fakeDeal(w, { brokerId: "b2" });
w.invites.push(
  { id: "i-own", dealId: deal.id, token: "tok-owner", sellerEmail: "owner@acme.invalid" } as any,
  { id: "i-acc", dealId: deal.id, token: "tok-acct", sellerEmail: "books@acme.invalid" } as any,
  { id: "i-att", dealId: deal.id, token: "tok-atty", sellerEmail: "law@acme.invalid" } as any,
  { id: "i-rep", dealId: deal.id, token: "tok-rep", sellerEmail: "rep@acme.invalid" } as any,
  { id: "i-rev", dealId: deal.id, token: "tok-revoked", sellerEmail: "gone@acme.invalid" } as any,
  { id: "i-oth", dealId: other.id, token: "tok-other", sellerEmail: "x@other.invalid" } as any,
);
w.members.push(
  { id: "m-acc", dealId: deal.id, teamType: "seller", role: "accountant", email: "books@acme.invalid", inviteStatus: "sent" } as any,
  { id: "m-att", dealId: deal.id, teamType: "seller", role: "attorney", email: "law@acme.invalid", inviteStatus: "sent" } as any,
  { id: "m-rep", dealId: deal.id, teamType: "seller", role: "representative", email: "rep@acme.invalid", inviteStatus: "sent" } as any,
  { id: "m-rev", dealId: deal.id, teamType: "seller", role: "owner", email: "gone@acme.invalid", inviteStatus: "revoked" } as any,
);

let sessionBroker: string | undefined;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).session = { brokerId: sessionBroker }; next(); });
applyGlRateLimits(app);
registerGlRoutes(app);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const docsDir = path.join(w.root, "docs");
const filesOnDisk = () => fs.readdirSync(docsDir).length;

async function upload(url: string, file = "qbo-2024-only.csv", fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([fs.readFileSync(fixture(file))]), file);
  const r = await fetch(base + url, { method: "POST", body: fd });
  return { status: r.status, json: await r.json().catch(() => null) };
}

await test("refused before a byte is written: bad link, attorney, representative, revoked member, preview, another broker, no session", async () => {
  const before = filesOnDisk();
  sessionBroker = undefined;
  assert.equal((await upload("/api/seller/nope/gl/ledgers")).status, 404);
  for (const t of ["tok-atty", "tok-rep", "tok-revoked"]) {
    const r = await upload(`/api/seller/${t}/gl/ledgers`);
    assert.equal(r.status, 403, t);
    assert.equal(r.json.error, "Your broker asked the business owner or the accountant to do this step.");
  }
  sessionBroker = "b1"; // the owning broker previewing the seller's page
  const prev = await upload("/api/seller/tok-owner/gl/ledgers");
  assert.equal(prev.status, 409);
  assert.equal(prev.json.error, UPLOAD_MESSAGES.preview);
  sessionBroker = "b2";
  assert.equal((await upload(`/api/deals/${deal.id}/gl/ledgers`)).status, 404, "another broker");
  sessionBroker = undefined;
  assert.equal((await upload(`/api/deals/${deal.id}/gl/ledgers`)).status, 401, "no session");
  assert.equal(filesOnDisk(), before, "no file was written by any refused request");
});

await test("the owner's and the accountant's links upload; the owning broker uploads (privately if asked)", async () => {
  sessionBroker = undefined;
  const a = await upload("/api/seller/tok-owner/gl/ledgers");
  assert.equal(a.status, 200);
  assert.equal(a.json.ledger.status, "reading");
  const b = await upload("/api/seller/tok-acct/gl/ledgers", "wave.csv");
  assert.equal(b.status, 200);
  sessionBroker = "b1";
  const c = await upload(`/api/deals/${deal.id}/gl/ledgers`, "qbd.csv", { visibility: "broker_only" });
  assert.equal(c.status, 200);
  assert.equal(c.json.ledger.audience, "broker");
  await glQueueIdle();
  const docs = Array.from(w.documents.values()).filter((d) => d.dealId === deal.id);
  assert.equal(docs.filter((d) => d.uploadedBy === "seller").length, 2);
  assert.ok(docs.every((d) => d.subcategory === "general_ledger" && d.category === "financials"));
  // The seller's view lists only what the seller may see.
  sessionBroker = undefined;
  const view = await (await fetch(`${base}/api/seller/tok-owner/gl`)).json();
  assert.equal(view.ledgers.length, 2);
  assert.ok(view.ledgers.every((l: any) => !("layout" in l) && !("audience" in l)));
  const atty = await fetch(`${base}/api/seller/tok-atty/gl`);
  assert.equal(atty.status, 403);
  // The broker's view lists all three, with the private one marked.
  sessionBroker = "b1";
  const broker = await (await fetch(`${base}/api/deals/${deal.id}/gl`)).json();
  assert.equal(broker.ledgers.length, 3);
  assert.equal(broker.ledgers.filter((l: any) => l.audience === "broker").length, 1);
  assert.ok(broker.ledgers.every((l: any) => l.status === "ready"));
});

await test("wrong file type → 400 with the plain advice, nothing kept", async () => {
  sessionBroker = "b1";
  const before = filesOnDisk();
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("%PDF-1.4")]), "General Ledger.pdf");
  const pdf = await fetch(`${base}/api/deals/${deal.id}/gl/ledgers`, { method: "POST", body: fd });
  assert.equal(pdf.status, 400);
  assert.equal((await pdf.json()).error, UPLOAD_MESSAGES.wrongType);
  assert.equal(filesOnDisk(), before);
});

await test("a declared size over the cap → 413 before reading the body", async () => {
  const mw = glUploadGate("broker", 1000);
  const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; }, on() {}, locals: {} };
  let nexted = false;
  await mw({ params: { dealId: deal.id }, headers: { "content-length": String(1000 + 70 * 1024) } } as any, res, () => { nexted = true; });
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, UPLOAD_MESSAGES.tooBig);
  assert.equal(nexted, false);
});

await test("at most 3 GL uploads in flight per server → 503", async () => {
  const mw = glUploadGate("broker", 10_000_000);
  const pending: Array<() => void> = [];
  const mk = () => {
    const handlers: Record<string, () => void> = {};
    const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; }, on(ev: string, fn: () => void) { handlers[ev] = fn; }, locals: {} };
    pending.push(() => handlers.finish?.());
    return res;
  };
  const results: any[] = [];
  for (let i = 0; i < GL_MAX_IN_FLIGHT + 1; i++) {
    const res = mk();
    await mw({ params: { dealId: deal.id }, headers: { "content-length": "100" } } as any, res, () => {});
    results.push(res);
  }
  assert.equal(glUploadsInFlight(), GL_MAX_IN_FLIGHT);
  assert.equal(results[GL_MAX_IN_FLIGHT].statusCode, 503);
  assert.equal(results[GL_MAX_IN_FLIGHT].body.error, UPLOAD_MESSAGES.busy);
  for (const p of pending) p();
  assert.equal(glUploadsInFlight(), 0);
});

await test(`${GL_UPLOADS_PER_IP_PER_HOUR} GL uploads an hour per IP, then 429 before anything is written`, async () => {
  sessionBroker = undefined;
  let last = 0;
  for (let i = 0; i < GL_UPLOADS_PER_IP_PER_HOUR + 2; i++) {
    const r = await fetch(`${base}/api/seller/nope/gl/ledgers`, { method: "POST", body: new FormData() });
    last = r.status;
  }
  assert.equal(last, 429);
  // Reads are never counted against the upload limit.
  sessionBroker = "b1";
  assert.equal((await fetch(`${base}/api/deals/${deal.id}/gl`)).status, 200);
});

server.close();
cleanup(w);
done("upload-gate");
