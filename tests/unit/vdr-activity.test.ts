/**
 * vdr spec §5.9, §9.4, §9.7, §11.4: the Activity view and what other
 * screens read from it.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-activity.test.ts
 *
 *  - by buyer: documents, time, pages, downloads, "from the DD CIM", each
 *    person on their team, what's new for them and not opened; the broker's
 *    previews never count
 *  - by document: readers of those who can see it, time, page strip
 *  - the log in plain sentences (team members named "for" their buyer),
 *    filters (buyer, person, document, action, dates), CSV with formula
 *    cells neutralised
 *  - a trace code from a leaked page finds the view and the reader
 *  - the profile timeline ("Opened 2 documents in the data room · 9 min" per
 *    day, downloads, requests, given the room) and the 7-day signals
 *  - HTTP: ?view=buyers|documents|log, trace, CSV; another deal's buyer,
 *    person or document in the filters → 404
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-activity-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";

const { activityByBuyer, activityByDocument, activityLog, activityCsv, findTrace, logSentence, vdrTimelineEvents, vdrSignals, csvCell } = await import("../../server/vdr/activity-report");
const { traceFor } = await import("../../server/vdr/activity");
const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");

const now = new Date("2026-10-09T12:00:00Z");
const accessRows: any[] = [
  { id: "dd", dealId: "D", buyerEmail: "Jane@Northgate.invalid", buyerName: "Jane Doe", buyerCompany: "Northgate Pharmacy Group", accessLevel: "due_diligence", createdAt: now },
  { id: "full", dealId: "D", buyerEmail: "sam@fullco.invalid", buyerName: "Sam", buyerCompany: "FullCo", accessLevel: "named", createdAt: now },
];
const team: any[] = [{ id: "tm1", name: "Priya Shah", role: "accountant", principalEmail: "jane@northgate.invalid" }];
const items: any[] = [
  { id: "I1", title: "T2 corporate tax return 2023", removedAt: null, prepared: { pages: [{}, {}, {}, {}] }, folderId: "F1" },
  { id: "I2", title: "Warehouse lease", removedAt: null, prepared: { pages: [{}, {}] }, folderId: "F2" },
  { id: "I3", title: "=HYPERLINK(\"evil\")", removedAt: null, prepared: null, folderId: "F2" },
];
const numbers = new Map([["I1", "1.2.2"], ["I2", "2.1.1"], ["I3", "2.1.2"]]);
const view = (id: string, extra: any) => ({ id, dealId: "D", buyerAccessId: "dd", buyerEmail: "jane@northgate.invalid", teamMemberId: null, itemId: "I1", documentId: "d1", fileVersion: 1, trace: traceFor(id, "k"), source: "room", startedAt: now, lastSeenAt: now, activeMs: 0, pageMs: {}, maxPage: null, deviceClass: "desktop", downloaded: false, ...extra });
const views: any[] = [
  view("00000000-0000-4000-8000-000000000001", { activeMs: 6 * 60_000, pageMs: { "1": 60_000, "2": 120_000, "3": 180_000 }, source: "cim" }),
  view("00000000-0000-4000-8000-000000000002", { activeMs: 14 * 60_000, pageMs: { "2": 400_000, "9": 1 }, teamMemberId: "tm1", downloaded: true }),
  view("00000000-0000-4000-8000-000000000003", { itemId: "I2", activeMs: 2 * 60_000, pageMs: { "1": 120_000 } }),
  view("00000000-0000-4000-8000-000000000004", { activeMs: 99 * 60_000, source: "preview" }),
];
const canSee = new Map<string, Set<string>>([["jane@northgate.invalid", new Set(["I1", "I2", "I3"])], ["sam@fullco.invalid", new Set(["I2"])]]);
const ctx = { items, numbers, accessRows, team, canSee, newFor: new Map([["jane@northgate.invalid", new Set(["I3"])]]) };

// ── By buyer ──
const byBuyer = activityByBuyer(views, ctx);
const jane = byBuyer.find((b) => b.key === "jane@northgate.invalid")!;
assert.equal(jane.label, "Northgate Pharmacy Group");
assert.equal(jane.openedDocs, 2);
assert.equal(jane.canSee, 3);
assert.equal(jane.activeMs, 22 * 60_000, "previews never count");
assert.equal(jane.downloads, 1);
assert.equal(jane.newNotOpened, 1, "new for them and not opened");
const t2 = jane.documents.find((d) => d.itemId === "I1")!;
assert.deepEqual([t2.opens, t2.fromCim, t2.downloads, t2.pages], [2, true, 1, [1, 2, 3, 9]]);
assert.deepEqual(jane.people.map((p) => [p.name, p.role, p.activeMs]), [["Jane Doe", "principal", 8 * 60_000], ["Priya Shah", "accountant", 14 * 60_000]], "each person on their team");
assert.deepEqual(jane.top.map((t) => t.itemId), ["I1", "I2"]);
const sam = byBuyer.find((b) => b.key === "sam@fullco.invalid")!;
assert.deepEqual([sam.openedDocs, sam.activeMs, sam.lastAt], [0, 0, null], "a buyer with the room who hasn't opened anything yet");

// ── By document ──
const byDoc = activityByDocument(views, ctx);
const d1 = byDoc.find((d) => d.itemId === "I1")!;
assert.deepEqual([d1.readers, d1.canSee, d1.activeMs, d1.downloads, d1.pageCount], [1, 1, 20 * 60_000, 1, 4]);
assert.equal(d1.pages["2"], 520_000, "page time summed across views");
assert.equal(byDoc.find((d) => d.itemId === "I2")!.canSee, 2);

// ── The log ──
const log: any[] = [
  { id: "a1", dealId: "D", at: new Date("2026-10-08T14:02:00Z"), actorKind: "team", actorId: "tm1", action: "buyer_opened_item", itemId: "I1", buyerEmail: "jane@northgate.invalid", detail: { source: "cim" } },
  { id: "a2", dealId: "D", at: new Date("2026-10-07T10:00:00Z"), actorKind: "broker", actorId: "b1", action: "shared", itemId: "I1", buyerEmail: null, detail: { from: "Not shared", to: "Due diligence buyers" } },
  { id: "a3", dealId: "D", at: new Date("2026-10-06T10:00:00Z"), actorKind: "buyer", actorId: "dd", action: "buyer_denied", itemId: "I2", buyerEmail: "jane@northgate.invalid", detail: null },
  { id: "a4", dealId: "D", at: new Date("2026-10-05T10:00:00Z"), actorKind: "buyer", actorId: "dd", action: "buyer_requested", itemId: null, buyerEmail: "jane@northgate.invalid", detail: { count: 34, kind: "document" } },
  { id: "a5", dealId: "D", at: new Date("2026-10-04T10:00:00Z"), actorKind: "broker", actorId: "b1", action: "seller_emailed", itemId: null, buyerEmail: null, detail: { count: 3, demo: true } },
];
const all = activityLog(log, ctx);
assert.equal(all[0].text, "Oct 8 14:02 · Priya Shah for Northgate Pharmacy Group opened 1.2.2 T2 corporate tax return 2023 (from the DD CIM)");
assert.equal(all[1].text, "Oct 7 10:00 · You shared 1.2.2 T2 corporate tax return 2023: Not shared → Due diligence buyers");
assert.equal(all[2].text, "Oct 6 10:00 · Northgate Pharmacy Group tried to open a document not shared with them");
assert.equal(all[3].text, "Oct 5 10:00 · Northgate Pharmacy Group asked for 34 documents");
assert.match(all[4].text, /emailed the seller about 3 documents \(example deal: recorded, not sent\)/);
assert.equal(all[0].person, "Priya Shah");
assert.deepEqual(activityLog(log, ctx, { person: "tm1" }).map((r) => r.id), ["a1"]);
assert.deepEqual(activityLog(log, ctx, { person: "principal" }).map((r) => r.id), ["a3", "a4"]);
assert.deepEqual(activityLog(log, ctx, { item: "I1" }).map((r) => r.id), ["a1", "a2"]);
assert.deepEqual(activityLog(log, ctx, { action: "buyer_denied" }).map((r) => r.id), ["a3"]);
assert.deepEqual(activityLog(log, ctx, { from: new Date("2026-10-06T00:00:00Z"), to: new Date("2026-10-07T23:59:59Z") }).map((r) => r.id), ["a2", "a3"]);
assert.deepEqual(activityLog(log, ctx, { buyer: "sam@fullco.invalid" }), []);
assert.match(logSentence({ action: "request_resolved", actorKind: "broker", actorId: "b1", itemId: null, buyerEmail: "jane@northgate.invalid", detail: { how: "ask_seller", text: "AR aging" } } as any, ctx).text, /You asked the seller for 'AR aging' \(Northgate Pharmacy Group asked for it\)/);

// CSV: quoted, formula-safe.
assert.equal(csvCell("=SUM(A1)"), `"'=SUM(A1)"`);
assert.equal(csvCell("+1"), `"'+1"`);
assert.equal(csvCell('He said "hi"'), `"He said ""hi"""`);
const csv = activityCsv(activityLog([{ ...log[0], itemId: "I3" }], ctx), ctx);
assert.ok(csv.startsWith("﻿\"When (UTC)\""));
assert.ok(csv.includes(`"'=HYPERLINK(""evil"")"`), "a document title that looks like a formula is neutralised");
assert.ok(!/(^|,)"=/m.test(csv), "no cell starts with =");

// Trace: a leaked page's code finds the reader.
const code = traceFor("00000000-0000-4000-8000-000000000002", "k");
const hits = findTrace(views, code.toLowerCase(), ctx);
assert.equal(hits.length, 1);
assert.deepEqual([hits[0].buyerLabel, hits[0].person, hits[0].number], ["Northgate Pharmacy Group", "Priya Shah (accountant)", "1.2.2"]);
assert.deepEqual(findTrace(views, "ZZZZZZ", ctx), []);
assert.deepEqual(findTrace(views, "12", ctx), [], "not a code");

// Timeline + signals.
const tl = vdrTimelineEvents({ accesses: [{ id: "dd", dealId: "D", buyerEmail: "JANE@northgate.invalid" }], views, activity: [
  ...log,
  { id: "g1", dealId: "D", at: new Date("2026-10-03T10:00:00Z"), actorKind: "broker", action: "buyer_room_changed", buyerEmail: "jane@northgate.invalid", detail: { roomAccess: "on" } },
  { id: "dl", dealId: "D", at: new Date("2026-10-08T15:00:00Z"), actorKind: "buyer", action: "buyer_downloaded", itemId: "I1", buyerEmail: "jane@northgate.invalid", detail: {} },
  { id: "x", dealId: "E", at: now, actorKind: "buyer", action: "buyer_downloaded", itemId: "I1", buyerEmail: "jane@northgate.invalid", detail: {} },
] as any, items }, (s) => `${Math.round(s / 60)} min`);
const titles = tl.map((e) => e.title).sort();
assert.ok(titles.includes("Opened 2 documents in the data room · 22 min"), JSON.stringify(titles));
assert.ok(titles.includes("Given the data room"));
assert.ok(titles.includes("Downloaded 'T2 corporate tax return 2023' from the data room"));
assert.ok(titles.includes("Asked for 34 documents"));
assert.ok(tl.every((e) => e.kind === "data_room" && e.dealId === "D"), "another deal's rows never show");
const sig = vdrSignals(views, items, new Set(["F1"]), now).get("jane@northgate.invalid")!;
assert.deepEqual([sig.activeMs7d, sig.docsOpened7d, sig.financialMs7d, sig.downloads7d, sig.teamMembersActive7d], [22 * 60_000, 2, 20 * 60_000, 1, 1]);

// ── HTTP ──
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "a.pdf"), "x");
fs.writeFileSync(path.join(root, "docs", "b.pdf"), "x");
const later = new Date("2026-11-30T00:00:00Z");
const app = await vdrTestApp({
  root,
  now,
  docs: [
    { id: "a", dealId: "D", name: "T2 2023", originalName: "a.pdf", category: "financials", fileUrl: "/uploads/docs/a.pdf", mimeType: "application/pdf", createdAt: now },
    { id: "b", dealId: "E", name: "Other T2", originalName: "b.pdf", category: "financials", fileUrl: "/uploads/docs/b.pdf", mimeType: "application/pdf", createdAt: now },
  ],
  deals: [{ id: "D", brokerId: "b1", businessName: "D Co", isLive: true, extractedInfo: {} }, { id: "E", brokerId: "b2", businessName: "E Co", isLive: true, extractedInfo: {} }],
  access: [
    { id: "dd", dealId: "D", buyerEmail: "jane@n.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
    { id: "E-dd", dealId: "E", buyerEmail: "x@e.invalid", accessToken: "tok-E-xxxxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  ],
});
await setUpRoom("D", "b1", "auto", app.setupDeps);
await setUpRoom("E", "b2", "auto", app.setupDeps);
const it = app.f.items.find((x) => x.dealId === "D")!;
const eItem = app.f.items.find((x) => x.dealId === "E")!;
it.prepared = { status: "ready", kind: "image", forFile: "0123456789abcdef", pages: [{ w: 1, h: 1, hasText: true }] };
fs.mkdirSync(vdrCacheDir("D", it.id, "0123456789abcdef", root)!, { recursive: true });
await app.f.store.insertShares([{ dealId: "D", itemId: it.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "t" }]);
const start = await app.call("POST", "/api/view/tok-dd-xxxxxxxxxx/data-room/views/start", { itemId: it.id, source: "room" });
assert.equal(start.status, 200);
let r = await app.call("GET", "/api/deals/D/data-room/activity?view=buyers", undefined, "b1");
assert.equal(r.status, 200);
assert.equal(r.json.buyers[0].label, "Northgate");
assert.equal(r.json.buyers[0].openedDocs, 1);
r = await app.call("GET", "/api/deals/D/data-room/activity?view=documents", undefined, "b1");
assert.equal(r.json.documents[0].readers, 1);
r = await app.call("GET", "/api/deals/D/data-room/activity?view=log", undefined, "b1");
assert.ok(r.json.log.some((x: any) => /Northgate opened/.test(x.text)), JSON.stringify(r.json.log));
assert.ok(r.json.filters.actions.length > 5);
r = await app.call("GET", `/api/deals/D/data-room/activity?view=log&trace=${start.json.trace}`, undefined, "b1");
assert.equal(r.json.trace.hits[0].email, "jane@n.invalid", "the page's code finds its reader");
assert.equal((await app.call("GET", "/api/deals/D/data-room/activity?view=log&buyer=E-dd", undefined, "b1")).status, 404, "another deal's buyer");
assert.equal((await app.call("GET", `/api/deals/D/data-room/activity?view=log&item=${eItem.id}`, undefined, "b1")).status, 404, "another deal's document");
assert.equal((await app.call("GET", "/api/deals/D/data-room/activity?view=log&person=nobody", undefined, "b1")).status, 404);
assert.equal((await app.call("GET", "/api/deals/D/data-room/activity?view=log", undefined, "b2")).status, 404, "another brokerage");
r = await app.call("GET", "/api/deals/D/data-room/activity.csv", undefined, "b1");
assert.equal(r.status, 200);
assert.match(r.headers.get("content-disposition") ?? "", /attachment; filename="data-room-activity.csv"/);
assert.ok(r.text.includes("Northgate"));
// The drawer's per-document readers still work (no ?view).
r = await app.call("GET", `/api/deals/D/data-room/activity?item=${it.id}`, undefined, "b1");
assert.equal(r.json.buyers.length, 1);
// The analytics contract (§11.4), on the same store.
const { vdrSignalsForDeal, vdrJourneyEvents, vdrBrokerTotals } = await import("../../server/vdr/timeline");
await app.call("POST", "/api/view/tok-dd-xxxxxxxxxx/data-room/views", { viewId: start.json.viewId, activeMs: 5000, pageMs: { "1": 5000 }, maxPage: 1 });
const sig2 = await vdrSignalsForDeal("D", now, app.f.store);
assert.equal(sig2.get("jane@n.invalid").docsOpened7d, 1);
assert.equal(sig2.get("jane@n.invalid").financialMs7d, 5000, "the T2 sits under Financial");
const journey = await vdrJourneyEvents("D", "JANE@n.invalid", app.f.store);
assert.ok(journey.some((e) => /Opened 1 document in the data room/.test(e.title)), JSON.stringify(journey));
const totals = await vdrBrokerTotals(["D", "E", "nope"], now, app.f.store);
assert.deepEqual(totals, { rooms: 2, documentsShared: 1, buyersReading7d: 1, activeMs7d: 5000 });
app.close();

console.log("vdr-activity: all passed");
