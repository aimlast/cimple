/**
 * vdr spec §6.6, §11.1–§11.2 (INTEGRATION §2.6): the contracts other streams
 * build on — citation lookups (buyer and broker), finding a figure's page,
 * `assertBuyerDocumentAccess` and gl's ledger rows route — over HTTP on an
 * in-memory store. No database, no AI, no email.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-resolve.test.ts
 *
 *  - resolve: a shared document → its room title and number; broker-only,
 *    not shared, unknown and another deal's ids → exactly `{ available: false }`
 *    (one shape, no name anywhere in the response); a Blind CIM link (no room)
 *    → every id unavailable; a replaced document follows to the visible new
 *    version (`replaced: true`); malformed / > 50 ids → 400
 *  - broker resolve: always the document's own name (broker-only too) and
 *    where it sits; another deal's id → unavailable; another broker → 404
 *  - locate: digits with any thousands separator, never inside a longer
 *    number; words case/space-insensitive; only the CURRENT served text;
 *    `?needle=` on the buyer's About and the broker's view → focusPage
 *  - assertBuyerDocumentAccess: the visible document → ctx (principal link,
 *    mode, viewer, a server trace that finds a stored view); hidden → 404;
 *    a second call within 30 min reuses the view; ledger rows → 404 until gl
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-resolve-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";
delete process.env.RESEND_API_KEY;

const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom, markReplacement, onSourceDeleted } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");
const { pageForNeedle, needleMatcher, locateNeedle } = await import("../../server/vdr/locate");
const { parseDocumentIds, latestVersion } = await import("../../server/vdr/resolve");
const { assertBuyerDocumentAccess, VdrHttpError } = await import("../../server/vdr/access");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
for (const n of ["t2.pdf", "lease.pdf", "fs.pdf", "fs2.pdf", "e.pdf", "crm.txt"]) fs.writeFileSync(path.join(root, "docs", n), "%PDF-1.4 fixture");
const docs: any[] = [
  { id: "t2", dealId: "D", name: "T2 corporate income tax return 2023", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "lease", dealId: "D", name: "Warehouse lease (Harbourline St)", originalName: "Lease.pdf", category: "legal", fileUrl: "/uploads/docs/lease.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "fs", dealId: "D", name: "Financial statements FY2023", originalName: "FS.pdf", category: "financials", fileUrl: "/uploads/docs/fs.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "priv", dealId: "D", name: "Seller's private valuation memo", originalName: "memo.pdf", category: "financials", fileUrl: "/uploads/docs/crm.txt", visibility: "broker_only", createdAt: now },
  { id: "E-doc", dealId: "E", name: "Other deal's secret T2", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/e.pdf", mimeType: "application/pdf", createdAt: now },
];
const deals = [
  { id: "D", brokerId: "b1", businessName: "Pacific Test Logistics", isLive: true, extractedInfo: {}, demoKey: null },
  { id: "E", brokerId: "b2", businessName: "Another brokerage's deal", isLive: true, extractedInfo: {}, demoKey: null },
];
const access: any[] = [
  { id: "dd", dealId: "D", buyerEmail: "Jane@Northgate.invalid", buyerName: "Jane Doe", buyerCompany: "Northgate", accessToken: "tok-dd-aaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "blind", dealId: "D", buyerEmail: "bo@blind.invalid", buyerName: "Bo", buyerCompany: "BlindCo", accessToken: "tok-blind-aaaaaaaaa", accessLevel: "full", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "E-dd", dealId: "E", buyerEmail: "x@e.invalid", buyerName: "Xavier", buyerCompany: "ECo", accessToken: "tok-E-aaaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
];
const app = await vdrTestApp({ root, docs, deals, access, now });
const { f, call } = app;
const setupDeps = { store: f.store, enqueue: () => {}, now: () => now };
await setUpRoom("D", "b1", "auto", setupDeps);
await setUpRoom("E", "b2", "auto", setupDeps);
const itemOf = (docId: string) => f.items.find((i: any) => i.documentId === docId && !i.removedAt)!;
const ready = (it: any) => {
  it.prepared = { status: "ready", kind: "pdf", forFile: "0123456789abcdef", pages: [{ w: 100, h: 140, hasText: true }, { w: 100, h: 140, hasText: true }, { w: 100, h: 140, hasText: true }], personal: { count: 0, kinds: [], pages: [] } };
  const dir = vdrCacheDir(it.dealId, it.id, "0123456789abcdef", root)!;
  fs.mkdirSync(dir, { recursive: true });
  for (const p of [1, 2, 3]) fs.writeFileSync(path.join(dir, `p${p}.webp`), "webp");
};
for (const it of f.items) ready(it);
const share = (docId: string, dealId = "D") => f.store.insertShares([{ dealId, itemId: itemOf(docId).id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "test" }]);
await share("t2");
await share("fs");
await share("E-doc", "E");
// Served page text of the T2: the figure is on page 3; a stale row from an old file must never answer.
await f.store.replacePageText({ dealId: "D", itemId: itemOf("t2").id, forFile: "0123456789abcdef", rows: [
  { page: 1, label: "Page 1", text: "T2 Corporation Income Tax Return. Business number 123456789 RC0001" },
  { page: 2, label: "Page 2", text: "Schedule 1. Net income 1,398,000 before adjustments; 129,180,000 total assets" },
  { page: 3, label: "Page 3", text: "Schedule 125 — Total revenue 29 180 000. Cost of sales 18,442,310" },
] });

const T = "/api/view/tok-dd-aaaaaaaaaaaa/data-room";
const B = "/api/deals/D/data-room";

await test("locate: figures by their digits, never inside a longer number; words loosely", () => {
  const pages = [
    { page: 1, text: "Revenue 129,180,000 (consolidated)" },
    { page: 2, text: "Total revenue 29 180 000 and net income $1,398,000" },
    { page: 3, text: "Total Revenue\n  for the year" },
  ];
  assert.equal(pageForNeedle(pages, "29,180,000"), 2);
  assert.equal(pageForNeedle(pages, "29180000"), 2);
  assert.equal(pageForNeedle(pages, "$1,398,000"), 2);
  assert.equal(pageForNeedle(pages, "129,180,000"), 1);
  assert.equal(pageForNeedle(pages, "total revenue for the year"), 3);
  assert.equal(pageForNeedle(pages, "9,999,999"), null);
  assert.equal(needleMatcher("12"), null, "a two-digit number is on every page");
  assert.equal(needleMatcher(""), null);
  assert.equal(needleMatcher(42 as any), null);
});

await test("locateNeedle (dd's call): the room item's served text only", async () => {
  assert.deepEqual(await locateNeedle("t2", "29,180,000", f.store), { page: 3 });
  assert.equal(await locateNeedle("lease", "29,180,000", f.store), null);
  assert.equal(await locateNeedle("not-a-doc", "29,180,000", f.store), null);
  // The served file changed: the old text never answers.
  const it = itemOf("t2");
  const saved = it.prepared;
  it.prepared = { ...saved, forFile: "fedcba9876543210" };
  assert.equal(await locateNeedle("t2", "29,180,000", f.store), null);
  it.prepared = saved;
});

await test("parseDocumentIds: ≤ 50 well-formed ids, deduped", () => {
  assert.deepEqual(parseDocumentIds("a,b,a"), ["a", "b"]);
  assert.deepEqual(parseDocumentIds(["a", "b,c"]), ["a", "b", "c"]);
  assert.equal(parseDocumentIds(""), null);
  assert.equal(parseDocumentIds("a,b/../c"), null);
  assert.equal(parseDocumentIds(Array.from({ length: 51 }, (_, i) => `d${i}`).join(",")), null);
});

await test("buyer resolve: a shared document → the room title; every hidden case → the same bare shape", async () => {
  const r = await call("GET", `${T}/resolve?documentIds=t2,lease,priv,unknown-doc,E-doc`);
  assert.equal(r.status, 200);
  const d = r.json.documents;
  assert.equal(d.t2.available, true);
  assert.equal(d.t2.itemId, itemOf("t2").id);
  assert.equal(d.t2.title, "T2 corporate income tax return 2023");
  assert.ok(typeof d.t2.number === "string" && d.t2.number.length > 0);
  for (const id of ["lease", "priv", "unknown-doc", "E-doc"]) assert.deepEqual(d[id], { available: false }, id);
  for (const word of ["Warehouse", "Harbourline", "valuation", "secret"]) assert.ok(!r.text.includes(word), `no name leaks: ${word}`);
});

await test("buyer resolve: a link without the room (Blind CIM) → every id unavailable, no error", async () => {
  const r = await call("GET", "/api/view/tok-blind-aaaaaaaaa/data-room/resolve?documentIds=t2,fs");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.documents, { t2: { available: false }, fs: { available: false } });
});

await test("buyer resolve: malformed or too many ids → 400; an unknown link → 404", async () => {
  assert.equal((await call("GET", `${T}/resolve?documentIds=a/../b`)).status, 400);
  assert.equal((await call("GET", `${T}/resolve`)).status, 400);
  assert.equal((await call("GET", `${T}/resolve?documentIds=${Array.from({ length: 51 }, (_, i) => `d${i}`).join(",")}`)).status, 400);
  assert.equal((await call("GET", "/api/view/no-such-token-aaaa/data-room/resolve?documentIds=t2")).status, 404);
});

await test("broker resolve: the document's own name (private ones too), where it sits; another deal's → unavailable", async () => {
  const r = await call("GET", `${B}/resolve?documentIds=t2,priv,lease,E-doc`, undefined, "b1");
  assert.equal(r.status, 200);
  const d = r.json.documents;
  assert.equal(d.t2.title, "T2 corporate income tax return 2023");
  assert.equal(d.t2.inRoom, true);
  assert.equal(d.priv.title, "Seller's private valuation memo");
  assert.equal(d.priv.brokerOnly, true);
  assert.equal(d.priv.inRoom, false);
  assert.equal(d.lease.inRoom, true);
  assert.deepEqual(d["E-doc"], { available: false });
  assert.ok(!r.text.includes("secret"));
  assert.equal((await call("GET", `${B}/resolve?documentIds=t2`, undefined, "b2")).status, 404, "another brokerage");
  assert.equal((await call("GET", `${B}/resolve?documentIds=t2`)).status, 401, "no session");
});

await test("a replaced document follows to the new version when it's visible (replaced: true)", async () => {
  fs.writeFileSync(path.join(root, "docs", "fs2.pdf"), "%PDF-1.4 fixture v2");
  const v2 = { id: "fs-v2", dealId: "D", name: "Financial statements FY2023 (restated)", originalName: "FS2.pdf", category: "financials", fileUrl: "/uploads/docs/fs2.pdf", mimeType: "application/pdf", createdAt: now };
  f.documents.push(v2);
  const next = await markReplacement("fs", "fs-v2", setupDeps as any);
  assert.ok(next);
  await onSourceDeleted({ id: "fs", dealId: "D" }, { bySeller: true }, setupDeps as any);
  f.documents.splice(f.documents.findIndex((x: any) => x.id === "fs"), 1);
  ready(f.items.find((i: any) => i.id === next!.id));
  // Not shared yet → unavailable (the new version isn't visible).
  let r = await call("GET", `${T}/resolve?documentIds=fs`);
  assert.deepEqual(r.json.documents.fs, { available: false });
  await f.store.insertShares([{ dealId: "D", itemId: next!.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "test" }]);
  r = await call("GET", `${T}/resolve?documentIds=fs`);
  assert.equal(r.json.documents.fs.available, true);
  assert.equal(r.json.documents.fs.itemId, next!.id);
  assert.equal(r.json.documents.fs.replaced, true);
  const b = await call("GET", `${B}/resolve?documentIds=fs`, undefined, "b1");
  assert.equal(b.json.documents.fs.replaced, true);
  assert.equal(b.json.documents.fs.documentId, "fs-v2");
  assert.equal(latestVersion([{ id: "a", replacedByItemId: "b", removedAt: null }, { id: "b", replacedByItemId: "a", removedAt: null }], "a"), "b", "a cycle stops");
});

await test("?needle= → focusPage on the buyer's About and the broker's view", async () => {
  const it = itemOf("t2");
  const about = await call("GET", `${T}/items/${it.id}?needle=${encodeURIComponent("29,180,000")}`);
  assert.equal(about.status, 200);
  assert.equal(about.json.focusPage, 3);
  const none = await call("GET", `${T}/items/${it.id}`);
  assert.equal(none.json.focusPage, null);
  const view = await call("GET", `${B}/items/${it.id}/view?needle=${encodeURIComponent("Cost of sales")}`, undefined, "b1");
  assert.equal(view.json.focusPage, 3);
});

await test("a cited figure is outlined: focusBoxes from the served spots (the cited page wins when it prints it)", async () => {
  const it = itemOf("t2");
  const dir = vdrCacheDir("D", it.id, "0123456789abcdef", root)!;
  fs.writeFileSync(path.join(dir, "spots.json"), JSON.stringify({ v: 1, pages: { "3": [[0.1, 0.2, 0.9, 0.23, "Schedule 125 — Total revenue 29 180 000"]], "2": [[0.1, 0.5, 0.9, 0.53, "129,180,000 total assets"]] } }));
  const about = await call("GET", `${T}/items/${it.id}?needle=${encodeURIComponent("29,180,000")}&page=1`);
  assert.equal(about.json.focusPage, 3, "page 1 doesn't print it → the page that does");
  assert.equal(about.json.focusBoxes.length, 1);
  const [x0, , x1] = about.json.focusBoxes[0];
  assert.ok(x0 > 0.1 + 0.8 * 0.6 && x1 <= 0.9 + 1e-9, `narrowed to the figure: ${about.json.focusBoxes[0]}`);
  const none = await call("GET", `${T}/items/${it.id}?needle=${encodeURIComponent("Total revenue")}`);
  assert.equal(none.json.focusPage, 3);
  fs.unlinkSync(path.join(dir, "spots.json"));
  const noSpots = await call("GET", `${T}/items/${it.id}?needle=${encodeURIComponent("29,180,000")}`);
  assert.equal(noSpots.json.focusPage, 3);
  assert.deepEqual(noSpots.json.focusBoxes, [], "prepared before spots existed: the page alone");
});

const req = { session: null, ip: "10.0.0.1" };
const deps = { store: f.store, accessByToken: async (t: string) => access.find((a) => a.accessToken === t), accessRowsForDeal: async (d: string) => access.filter((a) => a.dealId === d), getDeal: async (id: string) => deals.find((d) => d.id === id) as any, now: () => now, root };

await test("assertBuyerDocumentAccess: the visible document → ctx with a trace that finds a stored view", async () => {
  const ctx = await assertBuyerDocumentAccess(req, "tok-dd-aaaaaaaaaaaa", "t2", deps as any);
  assert.equal(ctx.access.id, "dd");
  assert.equal(ctx.deal.id, "D");
  assert.equal(ctx.item.documentId, "t2");
  assert.equal(ctx.mode, "dd");
  assert.equal(ctx.viewer.kind, "buyer");
  assert.equal(ctx.preview, false);
  assert.match(ctx.watermark.trace, /^[A-Z2-7]{6}$/);
  const view = f.views.find((v: any) => v.trace === ctx.watermark.trace);
  assert.ok(view && view.itemId === ctx.item.id && view.buyerAccessId === "dd");
  const opened = f.activity.filter((a: any) => a.action === "buyer_opened_item" && a.itemId === ctx.item.id).length;
  // Within 30 minutes: the same view, no second "opened" line.
  const again = await assertBuyerDocumentAccess(req, "tok-dd-aaaaaaaaaaaa", "t2", deps as any);
  assert.equal(again.watermark.trace, ctx.watermark.trace);
  again.logView();
  assert.equal(f.activity.filter((a: any) => a.action === "buyer_opened_item" && a.itemId === ctx.item.id).length, opened);
});

await test("assertBuyerDocumentAccess: not shared, broker-only, unknown, other deal, no room → 404 (one shape)", async () => {
  for (const [token, doc] of [["tok-dd-aaaaaaaaaaaa", "lease"], ["tok-dd-aaaaaaaaaaaa", "priv"], ["tok-dd-aaaaaaaaaaaa", "nope"], ["tok-dd-aaaaaaaaaaaa", "E-doc"], ["tok-dd-aaaaaaaaaaaa", "../x"]] as const) {
    await assert.rejects(assertBuyerDocumentAccess(req, token, doc, deps as any), (e: any) => e instanceof VdrHttpError && e.status === 404 && e.body.error === "Not found", `${doc}`);
  }
  await assert.rejects(assertBuyerDocumentAccess(req, "tok-blind-aaaaaaaaa", "t2", deps as any), (e: any) => e instanceof VdrHttpError && e.status === 403 && e.body.code === "no_room_access");
  // The owning broker previewing: a preview view, nothing logged as the buyer.
  const before = f.activity.length;
  const p = await assertBuyerDocumentAccess({ session: { brokerId: "b1" } }, "tok-dd-aaaaaaaaaaaa", "fs-v2", deps as any).catch(() => null);
  if (p) { assert.equal(p.preview, true); p.logView(); assert.equal(f.activity.length, before); }
});

await test("gl's ledger rows route: behind the same check; a document that is not a ready ledger → 404", async () => {
  assert.equal((await call("GET", `${T}/ledger/t2/rows`)).status, 404, "a tax return, not a ready ledger: the adapter answers null → Not found");
  assert.equal((await call("GET", `${T}/ledger/lease/rows`)).status, 404, "not shared");
  assert.equal((await call("GET", "/api/view/tok-blind-aaaaaaaaa/data-room/ledger/t2/rows")).status, 403, "no room");
});

app.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\nvdr-resolve: ${passed} passed`);
