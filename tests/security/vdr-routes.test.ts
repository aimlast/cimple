/**
 * vdr spec §9.2, §9.3, §13, §14 — the data room's HTTP routes, tenancy and
 * buyer isolation, on a small Express app with an in-memory store, a temp
 * UPLOADS_DIR and a fake render pool. No database, no AI, no email.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/security/vdr-routes.test.ts
 *
 * Broker routes: every id in the path, the query (as=, item=) and the body
 * (allow / deny, itemIds, folderId, documentId, beforeItemId) must belong to
 * the deal, else 404 — another brokerage's deal, link, item, folder or
 * document is never touched or revealed.
 * Buyer routes: a link opens only its own deal's room; a document not shared
 * with the reader (or another deal's) answers 404 everywhere and is never
 * listed or searched; a view id belongs to its reader and item.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-routes-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";
delete process.env.RESEND_API_KEY;

const express = (await import("express")).default;
const { fakeVdrStore } = await import("../unit/vdr-fake-store");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");
const { registerDataRoomRoutes } = await import("../../server/routes/data-room");
const { registerDataRoomBuyerRoutes } = await import("../../server/routes/data-room-buyer");
const { tokenHash } = await import("../../server/vdr/access");
const { _clearCompositeCache } = await import("../../server/vdr/serve");

const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
for (const n of ["a_t2.pdf", "a_lease.pdf", "a_fs.pdf", "a_crm.txt", "b_t2.pdf"]) fs.writeFileSync(path.join(root, "docs", n), "%PDF-1.4 fixture");

const docs = [
  { id: "A-t2", dealId: "A", name: "T2 corporate income tax return 2023", originalName: "T2 2023.pdf", category: "financials", fileUrl: "/uploads/docs/a_t2.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "A-lease", dealId: "A", name: "Warehouse lease", originalName: "Lease.pdf", category: "legal", fileUrl: "/uploads/docs/a_lease.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "A-fs", dealId: "A", name: "Financial statements FY2023", originalName: "FS 2023.pdf", category: "financials", fileUrl: "/uploads/docs/a_fs.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "A-crm", dealId: "A", name: "CRM note", originalName: "crm.txt", category: "other", fileUrl: "/uploads/docs/a_crm.txt", sourceKind: "crm", visibility: "broker_only", createdAt: now },
  { id: "B-t2", dealId: "B", name: "T2 of the other deal", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/b_t2.pdf", mimeType: "application/pdf", createdAt: now },
];
const f = fakeVdrStore({ documents: docs });
const deals = new Map<string, any>([
  ["A", { id: "A", brokerId: "b1", businessName: "Pacific Test Logistics", isLive: false, extractedInfo: {} }],
  ["B", { id: "B", brokerId: "b2", businessName: "Other Brokerage Deal", isLive: true, extractedInfo: {} }],
]);
const access: any[] = [
  { id: "acc-dd", dealId: "A", buyerEmail: "Jane@Northgate.invalid", buyerName: "Jane Doe", buyerCompany: "Northgate", accessToken: "tok-dd-aaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "acc-full", dealId: "A", buyerEmail: "sam@full.invalid", buyerName: "Sam", buyerCompany: "FullCo", accessToken: "tok-full-aaaaaaaaaa", accessLevel: "named", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "acc-blind", dealId: "A", buyerEmail: "bo@blind.invalid", buyerName: "Bo", buyerCompany: "BlindCo", accessToken: "tok-blind-aaaaaaaaa", accessLevel: "full", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "acc-nonda", dealId: "A", buyerEmail: "no@nda.invalid", buyerName: "Nora", buyerCompany: null, accessToken: "tok-nonda-aaaaaaaaa", accessLevel: "due_diligence", ndaSigned: false, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "acc-B", dealId: "B", buyerEmail: "x@b.invalid", buyerName: "Xavier", buyerCompany: "BCo", accessToken: "tok-B-aaaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
];
const setupDeps = { store: f.store, enqueue: () => {}, now: () => now };
await setUpRoom("A", "b1", "auto", setupDeps);
await setUpRoom("B", "b2", "auto", setupDeps);
const itemOf = (docId: string) => f.items.find((i) => i.documentId === docId && !i.removedAt)!;
// Every room item is "ready" (an image kind: one page) with its base page in the cache.
for (const it of f.items) {
  it.prepared = { status: "ready", kind: "image", forFile: "0123456789abcdef", pages: [{ w: 100, h: 140, hasText: true }], personal: { count: 0, kinds: [], pages: [] } };
  const dir = vdrCacheDir(it.dealId, it.id, "0123456789abcdef", root)!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "p1.webp"), "webp");
}
await f.store.insertShares([{ dealId: "A", itemId: itemOf("A-t2").id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "test" }]);
await f.store.insertShares([{ dealId: "B", itemId: itemOf("B-t2").id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "test" }]);
// A team member of Northgate whose link was never activated (requested), and one active.
f.team.push({ id: "tm-req", dealId: "A", principalEmail: "jane@northgate.invalid", addedViaAccessId: "acc-dd", name: "Priya", email: "priya@acct.invalid", role: "accountant", status: "requested", tokenHash: tokenHash("team-requested-token"), ackAt: null, createdBy: "buyer" });

const composites: any[] = [];
const fakePool = {
  run: async (job: any) => {
    if (job.kind === "composite") { composites.push(job); return { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), width: 100, height: 140 }; }
    throw new Error(`unexpected job ${job.kind}`);
  },
};
const getDeal = async (id: string) => deals.get(id);
const accessRowsForDeal = async (dealId: string) => access.filter((a) => a.dealId === dealId).map((a) => ({ ...a }));

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = { brokerId: req.get("x-test-broker") || undefined }; next(); });
registerDataRoomRoutes(app as any, {
  store: f.store,
  getDeal,
  accessRowsForDeal,
  requirementsForDeal: async () => [],
  brokerName: async () => "Morgan",
  brand: async () => ({ firmName: "Brassline", logoUrl: null }),
  ddCited: async () => null,
  setup: () => setupDeps,
  serve: () => ({ pool: fakePool as any, root }),
  root: () => root,
  now: () => now,
  questionsForDeal: async () => [],
  createRequirement: async (row: any) => ({ id: `req-${Math.random()}`, createdAt: now, ...row }),
  discrepanciesForDeal: async () => [],
  cimSectionsForDeal: async () => [],
  sellerEmail: { notifySellerPortal: async () => ({ recipients: 0, emailsSent: 0 }) },
  buyerEmail: { sendDirect: async () => true, broker: async () => ({ name: "Morgan", email: null, company: null }), appUrl: () => "https://app.example.invalid" },
  summary: () => ({ store: f.store, getDeal, now: () => now }),
  servedSections: async () => [],
});
registerDataRoomBuyerRoutes(app as any, {
  store: f.store,
  accessByToken: async (t: string) => access.find((a) => a.accessToken === t),
  accessRowsForDeal,
  getDeal,
  now: () => now,
  root,
  serve: { pool: fakePool as any, root },
  brand: async () => ({ firmName: "Brassline", logoUrl: null }),
  questionsForDeal: async () => [],
  createQuestion: async (row: any) => ({ id: `q-${Math.random()}`, createdAt: now, ...row }),
  notifyBroker: async () => undefined,
  servedSections: async () => [],
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, p: string, body?: unknown, broker?: string) => {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(broker ? { "x-test-broker": broker } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: r.status, json, text };
};

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); } catch (err: any) { failures.push(name); console.log(`FAIL ${name}: ${String(err?.message ?? err).split("\n")[0]}`); }
}
const A = "/api/deals/A/data-room";
const t2A = itemOf("A-t2").id;
const leaseA = itemOf("A-lease").id;
const t2B = itemOf("B-t2").id;
const folderB = f.folders.find((x) => x.dealId === "B")!.id;
const folderA = f.folders.find((x) => x.dealId === "A" && x.presetKey === "financial.tax")!.id;

// ── Broker: the deal and every id it carries ──────────────────────────
await check("no session → 401", async () => { assert.equal((await call("GET", A)).status, 401); });
await check("another brokerage's deal → 404", async () => { assert.equal((await call("GET", A, undefined, "b2")).status, 404); });
await check("own deal → 200; the CRM note stays out", async () => {
  const r = await call("GET", A, undefined, "b1");
  assert.equal(r.status, 200);
  assert.ok(r.json.items.some((i: any) => i.id === t2A));
  assert.ok(!r.json.items.some((i: any) => i.documentId === "A-crm"));
  assert.ok(!JSON.stringify(r.json).includes("/uploads/docs/"), "no file path ever leaves the server");
});
await check("as= another deal's link on view and pages → 404", async () => {
  assert.equal((await call("GET", `${A}/items/${t2A}/view?as=acc-B`, undefined, "b1")).status, 404);
  assert.equal((await call("GET", `${A}/items/${t2A}/pages/1?as=acc-B`, undefined, "b1")).status, 404);
  assert.equal((await call("GET", `${A}/preview/acc-B`, undefined, "b1")).status, 404);
});
await check("item= another deal's item on activity → 404", async () => {
  assert.equal((await call("GET", `${A}/activity?item=${t2B}`, undefined, "b1")).status, 404);
});
await check("shares PUT: another deal's link in allow / deny → 404", async () => {
  assert.equal((await call("PUT", `${A}/items/${leaseA}/shares`, { levels: [], allow: ["acc-B"], deny: [] }, "b1")).status, 404);
  assert.equal((await call("PUT", `${A}/items/${leaseA}/shares`, { levels: [], allow: [], deny: ["acc-B"] }, "b1")).status, 404);
});
await check("shares PUT on another deal's item → 404", async () => {
  assert.equal((await call("PUT", `${A}/items/${t2B}/shares`, { levels: ["due_diligence"], allow: [], deny: [] }, "b1")).status, 404);
});
await check("bulk: another deal's item, link or folder → 404", async () => {
  assert.equal((await call("POST", `${A}/shares/bulk`, { itemIds: [t2B], add: { levels: ["due_diligence"] } }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/shares/bulk`, { itemIds: [leaseA], add: { allow: ["acc-B"] } }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/shares/bulk`, { folderId: folderB, add: { levels: ["due_diligence"] } }, "b1")).status, 404);
});
await check("PATCH buyers/:accessId with another deal's link → 404", async () => {
  assert.equal((await call("PATCH", `${A}/buyers/acc-B`, { allowDownloads: true }, "b1")).status, 404);
});
await check("items, folders and documents of another deal → 404", async () => {
  assert.equal((await call("PATCH", `${A}/items/${t2B}`, { title: "x" }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/items/move`, { itemIds: [leaseA], folderId: folderB }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/items/move`, { itemIds: [t2B], folderId: folderA }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/items/move`, { itemIds: [leaseA], folderId: folderA, beforeItemId: t2B }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/items`, { documentId: "B-t2" }, "b1")).status, 404);
  assert.equal((await call("PATCH", `${A}/folders/${folderB}`, { name: "x" }, "b1")).status, 404);
  assert.equal((await call("DELETE", `${A}/folders/${folderB}`, undefined, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/items/${t2B}/checked`, {}, "b1")).status, 404);
  assert.equal((await call("GET", `${A}/items/${t2B}/download`, undefined, "b1")).status, 404);
  assert.equal(f.items.find((i) => i.id === t2B)!.title, "T2 of the other deal", "untouched");
});
await check("plan with another deal's folder → 404", async () => {
  assert.equal((await call("POST", `${A}/plan`, { folders: [{ folderId: folderB, levels: ["due_diligence"] }] }, "b1")).status, 404);
});
await check("a broker-only document can't be placed (400 with the reason)", async () => {
  const r = await call("POST", `${A}/items`, { documentId: "A-crm" }, "b1");
  assert.equal(r.status, 400);
  assert.match(r.json.error, /broker-only/);
});
await check("teaser / Blind CIM links can't be given documents (400), legacy keys are normalised", async () => {
  const r = await call("PUT", `${A}/items/${leaseA}/shares`, { levels: [], allow: ["acc-blind"], deny: [] }, "b1");
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Move them to Full CIM/);
  assert.equal((await call("PUT", `${A}/items/${leaseA}/shares`, { levels: ["teaser"], allow: [], deny: [] }, "b1")).status, 400);
  const ok = await call("PUT", `${A}/items/${leaseA}/shares`, { levels: ["loi"], allow: [], deny: [] }, "b1");
  assert.equal(ok.status, 200);
  assert.deepEqual(f.shares.filter((s) => s.itemId === leaseA).map((s) => s.accessLevel), ["named"], "stored as the registry's key");
  await call("PUT", `${A}/items/${leaseA}/shares`, { levels: [], allow: [], deny: [] }, "b1");
});
await check("PATCH buyers: Blind CIM link refused (409)", async () => {
  assert.equal((await call("PATCH", `${A}/buyers/acc-blind`, { roomAccess: "on" }, "b1")).status, 409);
});

// ── Buyer: one link, one deal, only what's shared ─────────────────────
const V = (t: string) => `/api/view/${t}/data-room`;
await check("the DD buyer's room lists only the shared document (no isLive needed)", async () => {
  const r = await call("GET", V("tok-dd-aaaaaaaaaaaa"));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.items.map((i: any) => i.id), [t2A]);
  assert.ok(!JSON.stringify(r.json).includes("Warehouse lease"), "an unshared title never reaches the buyer");
});
await check("a DD link can't open another deal's item (404 on every route)", async () => {
  const t = "tok-dd-aaaaaaaaaaaa";
  assert.equal((await call("GET", `${V(t)}/items/${t2B}`)).status, 404);
  assert.equal((await call("GET", `${V(t)}/items/${t2B}/pages/1?v=00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await call("POST", `${V(t)}/views/start`, { itemId: t2B })).status, 404);
  assert.equal((await call("GET", `${V(t)}/items/${t2B}/download`)).status, 404);
});
await check("an unshared document is 404 (not 403) and never searched", async () => {
  const t = "tok-dd-aaaaaaaaaaaa";
  const r = await call("GET", `${V(t)}/items/${leaseA}`);
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "Not found" });
  f.pageText.push({ id: "pt1", dealId: "A", itemId: leaseA, forFile: "0123456789abcdef", page: 1, label: "Page 1", text: "Landlord Kestrel Holdings rent 42,000" });
  f.pageText.push({ id: "pt2", dealId: "A", itemId: t2A, forFile: "0123456789abcdef", page: 1, label: "Page 1", text: "Sales 29,180,000 Kestrel" });
  const s = await call("GET", `${V(t)}/search?q=Kestrel`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.hits.map((h: any) => h.itemId), [t2A]);
});
await check("a shared document opens: view → watermarked page with the server's trace", async () => {
  const t = "tok-dd-aaaaaaaaaaaa";
  const start = await call("POST", `${V(t)}/views/start`, { itemId: t2A, source: "room", width: 1440 });
  assert.equal(start.status, 200);
  assert.match(start.json.trace, /^[A-Z2-7]{6}$/);
  _clearCompositeCache();
  const page = await fetch(`${base}${V(t)}/items/${t2A}/pages/1?w=700&v=${start.json.viewId}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "image/jpeg");
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'; sandbox/);
  const job = composites[composites.length - 1];
  assert.ok(job.mark.line.includes(start.json.trace) && job.mark.line.includes("Jane@Northgate.invalid"), "the trace and the reader are burned in");
  // Without a view (or another reader's view) the page isn't served.
  assert.equal((await call("GET", `${V(t)}/items/${t2A}/pages/1`)).status, 404);
  assert.equal((await call("GET", `${V("tok-full-aaaaaaaaaa")}/items/${t2A}/pages/1?v=${start.json.viewId}`)).status, 403, "the Full CIM buyer has no room yet");
});
await check("a beat for another reader's view is refused (404)", async () => {
  await call("PATCH", `${A}/buyers/acc-full`, { roomAccess: "on" }, "b1");
  await call("PUT", `${A}/items/${t2A}/shares`, { levels: ["due_diligence", "named"], allow: [], deny: [] }, "b1");
  const mine = await call("POST", `${V("tok-dd-aaaaaaaaaaaa")}/views/start`, { itemId: t2A });
  const theirs = await call("POST", `${V("tok-full-aaaaaaaaaa")}/views`, { viewId: mine.json.viewId, activeMs: 5000, pageMs: { "1": 5000 } });
  assert.equal(theirs.status, 404);
  const ok = await call("POST", `${V("tok-dd-aaaaaaaaaaaa")}/views`, { viewId: mine.json.viewId, activeMs: 5000, pageMs: { "1": 5000 }, maxPage: 1 });
  assert.equal(ok.status, 204);
  assert.equal(f.views.find((v) => v.id === mine.json.viewId)!.activeMs, 5000);
});
await check("Hide it from: the hidden buyer gets 404; the others still see it", async () => {
  const r = await call("PUT", `${A}/items/${t2A}/shares`, { levels: ["due_diligence", "named"], allow: [], deny: ["acc-full"] }, "b1");
  assert.equal(r.status, 200);
  assert.equal((await call("GET", `${V("tok-full-aaaaaaaaaa")}/items/${t2A}`)).status, 404);
  assert.equal((await call("GET", `${V("tok-dd-aaaaaaaaaaaa")}/items/${t2A}`)).status, 200);
});
await check("Blind CIM, no NDA, another deal's token and a requested team link are refused", async () => {
  assert.equal((await call("GET", V("tok-blind-aaaaaaaaa"))).json.code, "no_room_access");
  assert.equal((await call("GET", V("tok-nonda-aaaaaaaaa"))).json.code, "nda_required");
  const b = await call("GET", `${V("tok-B-aaaaaaaaaaaaa")}/items/${t2A}`);
  assert.equal(b.status, 404);
  assert.equal((await call("GET", V("team-requested-token"))).status, 404);
  assert.equal((await call("GET", V("no-such-token-at-all"))).status, 404);
});
await check("closing the room stops the buyer at once", async () => {
  await call("PATCH", `${A}/settings`, { status: "closed" }, "b1");
  const r = await call("GET", V("tok-dd-aaaaaaaaaaaa"));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "room_closed");
  await call("PATCH", `${A}/settings`, { status: "open" }, "b1");
  assert.equal((await call("GET", V("tok-dd-aaaaaaaaaaaa"))).status, 200);
});
await check("a broker-only switch on the document hides it immediately (404)", async () => {
  const doc = f.documents.find((d) => d.id === "A-t2")!;
  doc.visibility = "broker_only";
  assert.equal((await call("GET", `${V("tok-dd-aaaaaaaaaaaa")}/items/${t2A}`)).status, 404);
  doc.visibility = "shared";
});
await check("View as a buyer: the broker sees exactly that buyer's room, nothing recorded", async () => {
  const views = f.views.length;
  const r = await call("GET", `${A}/preview/acc-dd`, undefined, "b1");
  assert.equal(r.status, 200);
  assert.equal(r.json.reader.kind, "preview");
  assert.deepEqual(r.json.items.map((i: any) => i.id), [t2A]);
  const blind = await call("GET", `${A}/preview/acc-blind`, undefined, "b1");
  assert.equal(blind.json.code, "no_room_access", "the same state the buyer would get");
  _clearCompositeCache();
  const page = await fetch(`${base}${A}/items/${t2A}/pages/1?w=700&as=acc-dd`, { headers: { "x-test-broker": "b1" } });
  assert.equal(page.status, 200);
  assert.match(composites[composites.length - 1].mark.line, /PREVIEW/);
  assert.equal(f.views.length, views, "no view recorded");
  assert.equal((await fetch(`${base}${A}/items/${leaseA}/pages/1?w=700&as=acc-dd`, { headers: { "x-test-broker": "b1" } })).status, 404, "not shared with them → not in their preview");
});
await check("revoking the link stops every route", async () => {
  const a = access.find((x) => x.id === "acc-dd")!;
  a.revokedAt = now;
  assert.equal((await call("GET", `${V("tok-dd-aaaaaaaaaaaa")}/items/${t2A}`)).status, 403);
  a.revokedAt = null;
});

// ── Pass 3: requests, To do, notes, descriptions, emails, activity ──────
await check("pass 3 broker routes: another brokerage's deal → 404 everywhere", async () => {
  for (const [m, p] of [["GET", "todo"], ["GET", "requests"], ["GET", "questions"], ["GET", `items/${t2A}/notes`], ["GET", "activity?view=log"], ["GET", "activity.csv"]] as const) {
    assert.equal((await call(m, `${A}/${p}`, undefined, "b2")).status, 404, p);
  }
  assert.equal((await call("POST", `${A}/summaries/accept`, { itemIds: [t2A] }, "b2")).status, 404);
  assert.equal((await call("POST", `${A}/requests/email-seller`, { requirementIds: ["x"] }, "b2")).status, 404);
});
await check("pass 3: another deal's request, item, link or folder in a path, query or body → 404", async () => {
  const bReq = (await f.store.insertRequests([{ dealId: "B", buyerAccessId: "acc-B", buyerEmail: "x@b.invalid", kind: "document", text: "x", status: "open" }]))[0];
  assert.equal((await call("PATCH", `${A}/requests/${bReq.id}`, { action: "decline" }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/requests/${bReq.id}/share-and-tell`, {}, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/requests/${bReq.id}/tell-buyer`, { subject: "s", message: "m" }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/requests/bulk`, { action: "decline", requestIds: [bReq.id] }, "b1")).status, 404);
  const aReq = (await f.store.insertRequests([{ dealId: "A", buyerAccessId: "acc-dd", buyerEmail: "jane@northgate.invalid", kind: "document", text: "y", status: "open" }]))[0];
  assert.equal((await call("PATCH", `${A}/requests/${aReq.id}`, { action: "share", itemId: t2B }, "b1")).status, 404, "sharing another deal's item");
  assert.equal((await call("GET", `${A}/items/${t2B}/notes`, undefined, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/items/${t2B}/summary`, {}, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/items/${t2B}/summary/ensure`, {}, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/summaries/accept`, { itemIds: [t2B] }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/let-buyers-know/draft`, { itemIds: [t2A], accessIds: ["acc-B"] }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/let-buyers-know/draft`, { itemIds: [t2B], accessIds: ["acc-dd"] }, "b1")).status, 404);
  assert.equal((await call("POST", `${A}/todo/dismiss`, { key: `hint:${t2B}` }, "b1")).status, 404);
  assert.equal((await call("GET", `${A}/activity?view=log&buyer=acc-B`, undefined, "b1")).status, 404);
  assert.equal((await call("GET", `${A}/activity?view=buyers&item=${t2B}`, undefined, "b1")).status, 404);
});
await check("pass 3 buyer routes: a link asks only in its own room; hidden items → 404", async () => {
  // A request naming another deal's item, or an item not shared with them.
  assert.equal((await call("POST", `${V("tok-dd-aaaaaaaaaaaa")}/requests`, { text: "x", itemId: t2B })).status, 404);
  assert.equal((await call("POST", `${V("tok-dd-aaaaaaaaaaaa")}/requests`, { text: "x", itemId: leaseA })).status, 404);
  assert.equal((await call("POST", `${V("tok-dd-aaaaaaaaaaaa")}/requests`, { text: "x", documentId: "B-t2" })).status, 404);
  // A question about another deal's item / an unshared one.
  assert.equal((await call("POST", `${V("tok-dd-aaaaaaaaaaaa")}/items/${t2B}/questions`, { question: "x" })).status, 404);
  assert.equal((await call("POST", `${V("tok-dd-aaaaaaaaaaaa")}/items/${leaseA}/questions`, { question: "x" })).status, 404);
  // Blind / no-NDA links can't ask for documents; a team link that was never activated can't ask anything.
  assert.equal((await call("POST", `${V("tok-blind-aaaaaaaaa")}/requests`, { text: "x" })).status, 403);
  assert.equal((await call("POST", `${V("team-requested-token")}/requests`, { text: "x" })).status, 404);
  // The room payload lists only this buyer's own requests.
  await f.store.insertRequests([{ dealId: "A", buyerAccessId: "acc-full", buyerEmail: "sam@full.invalid", kind: "document", text: "Sam's own request", status: "open" }]);
  const room = await call("GET", V("tok-dd-aaaaaaaaaaaa"));
  assert.ok(!JSON.stringify(room.json.requests ?? []).includes("Sam's own request"), "never another buyer's request");
});

server.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nvdr-routes: all passed");
process.exit(0);
