/**
 * vdr spec §5.8, §6.5, §9.2–§9.3, V15: buyers' document requests, end to end
 * over HTTP on an in-memory store. No database, no AI, no email (emails are
 * recorded by the harness, never sent).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-requests.test.ts
 *
 *  - a pasted list → one row per line (blank lines and bullets dropped, ≤ 100);
 *    101 lines → 400; a named item the buyer can't see → 404; a citation's
 *    document of another deal → 404; the broker is alerted once per call
 *  - room access: a Blind CIM link may ask (once), a teaser link never (C23),
 *    a buyer who already has the room gets 409
 *  - Ask the seller → "buyer_request" checklist rows with the note and needed-by
 *    date, never naming the buyer; "Email the seller now" → ONE seller email
 *    (seller_document_request, or the fallback key when the switch is off)
 *  - a file linked to that row → "Ready to share" → share-and-tell adds the
 *    buyer's own grant, closes the request and returns the prefilled email;
 *    Tell the buyer sends it with their own link; demo deals record, never send
 *  - Decline → the buyer sees the broker's note; "Waiting on you" lists the
 *    requests (a pasted list once) and the ready one; the KPI counts them
 *  - tenancy: another deal's request / checklist row → 404
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-requests-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";
delete process.env.RESEND_API_KEY;

const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");
const { onRequirementFulfilled, parseBuyerRequest, requirementCategoryFor, parseNeededBy } = await import("../../server/vdr/requests");
const { sellerDocumentRequestEvent, sellerRequestEmail } = await import("../../server/vdr/emails");

const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
for (const n of ["t2.pdf", "lease.pdf", "fs.pdf", "ar.pdf", "e.pdf"]) fs.writeFileSync(path.join(root, "docs", n), "%PDF-1.4 fixture");
const docs: any[] = [
  { id: "t2", dealId: "D", name: "T2 corporate income tax return 2023", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "lease", dealId: "D", name: "Warehouse lease", originalName: "Lease.pdf", category: "legal", fileUrl: "/uploads/docs/lease.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "fs", dealId: "D", name: "Financial statements FY2023", originalName: "FS.pdf", category: "financials", fileUrl: "/uploads/docs/fs.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "E-doc", dealId: "E", name: "Other deal's T2", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/e.pdf", mimeType: "application/pdf", createdAt: now },
];
const deals = [
  { id: "D", brokerId: "b1", businessName: "Pacific Test Logistics", isLive: true, extractedInfo: {}, demoKey: null },
  { id: "E", brokerId: "b2", businessName: "Another brokerage's deal", isLive: true, extractedInfo: {}, demoKey: null },
];
const access: any[] = [
  { id: "dd", dealId: "D", buyerEmail: "Jane@Northgate.invalid", buyerName: "Jane Doe", buyerCompany: "Northgate", accessToken: "tok-dd-aaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now, buyerUserId: null },
  { id: "blind", dealId: "D", buyerEmail: "bo@blind.invalid", buyerName: "Bo", buyerCompany: "BlindCo", accessToken: "tok-blind-aaaaaaaaa", accessLevel: "full", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "teaser", dealId: "D", buyerEmail: "t@teaser.invalid", buyerName: "Tee", buyerCompany: "TeaserCo", accessToken: "tok-teaser-aaaaaaaa", accessLevel: "teaser_only", ndaSigned: false, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "E-dd", dealId: "E", buyerEmail: "x@e.invalid", buyerName: "Xavier", buyerCompany: "ECo", accessToken: "tok-E-aaaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
];
const app = await vdrTestApp({ root, docs, deals, access, now });
const { f, call } = app;
await setUpRoom("D", "b1", "auto", app.setupDeps);
await setUpRoom("E", "b2", "auto", app.setupDeps);
for (const it of f.items) {
  it.prepared = { status: "ready", kind: "image", forFile: "0123456789abcdef", pages: [{ w: 100, h: 140, hasText: true }] };
  fs.mkdirSync(vdrCacheDir(it.dealId, it.id, "0123456789abcdef", root)!, { recursive: true });
  fs.writeFileSync(path.join(vdrCacheDir(it.dealId, it.id, "0123456789abcdef", root)!, "p1.webp"), "webp");
}
const itemOf = (doc: string) => f.items.find((i) => i.documentId === doc && !i.removedAt)!;
// The T2 is shared with due-diligence buyers; the lease isn't.
await f.store.insertShares([{ dealId: "D", itemId: itemOf("t2").id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "test" }]);

const B = "/api/view/tok-dd-aaaaaaaaaaaa/data-room";
const R = "/api/deals/D/data-room";

// ── Pure helpers ──
const list = parseBuyerRequest({ list: "1. Monthly bank statements\n\n- AR aging June 2026\n• Equipment leases\n   \n" }) as any;
assert.deepEqual(list.rows.map((r: any) => r.text), ["Monthly bank statements", "AR aging June 2026", "Equipment leases"], "bullets, numbering and blank lines dropped");
assert.equal(list.list, true);
assert.match((parseBuyerRequest({ list: Array.from({ length: 101 }, (_, i) => `Doc ${i}`).join("\n") }) as any).error, /101 lines/);
assert.match((parseBuyerRequest({ text: "   " }) as any).error, /Say which document/);
assert.equal(requirementCategoryFor("T2 2024 tax return"), "tax");
assert.equal(requirementCategoryFor("Most recent AR aging"), "financial");
assert.equal(requirementCategoryFor("Warehouse lease amendment"), "legal");
assert.equal(requirementCategoryFor("Something else entirely"), "operational");
assert.equal(parseNeededBy("2026-10-01", now).ok, false, "a date that passed");
assert.equal((parseNeededBy("2026-10-20", now) as any).at.toISOString().slice(0, 10), "2026-10-20");
assert.equal(sellerDocumentRequestEvent(), "seller_document_request", "the additive routing key (Q21)");
assert.equal(sellerDocumentRequestEvent({}, true), "seller_followup_questions", "without the key: the fallback");
assert.equal(sellerDocumentRequestEvent({ seller_document_request: {} }, false), "seller_followup_questions", "the switch off: the fallback");
const mail = sellerRequestEmail([{ documentName: "AR aging <June>", notes: "Most recent month", neededBy: "2026-10-20T12:00:00Z" }, { documentName: "Bank statements" }]);
assert.equal(mail.title, "Your broker added 2 documents to your checklist");
assert.ok(mail.body.includes("AR aging &lt;June&gt;") && mail.body.includes("needed by Oct 20"), "escaped, with the date");

// ── A buyer's requests ──
let r = await call("POST", `${B}/requests`, { list: "Monthly bank statements, last 12 months\nAR aging June 2026\n\nEquipment leases" });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.count, 3);
const listRows = f.requests.filter((x) => x.listId);
assert.equal(listRows.length, 3);
assert.equal(new Set(listRows.map((x) => x.listId)).size, 1, "one list id");
assert.ok(listRows.every((x) => x.buyerEmail === "jane@northgate.invalid" && x.buyerAccessId === "dd" && x.status === "open"));
assert.equal(app.alerts.length, 1, "the broker is alerted once per call");
assert.equal((await call("POST", `${B}/requests`, { list: Array.from({ length: 101 }, (_, i) => `Doc ${i}`).join("\n") })).status, 400);
assert.equal((await call("POST", `${B}/requests`, { text: "The lease", itemId: itemOf("lease").id })).status, 404, "an item they can't see");
assert.equal((await call("POST", `${B}/requests`, { text: "From the DD CIM", documentId: "E-doc" })).status, 404, "another deal's document");
r = await call("POST", `${B}/requests`, { text: "Tax return 2023", documentId: "lease" });
assert.equal(r.status, 200, "a citation's document of this deal (any visibility) is fine");
assert.ok(!JSON.stringify(r.json).includes("lease") && !JSON.stringify(r.json).includes("Warehouse"), "never echoed back");
r = await call("POST", `${B}/requests`, { text: "Most recent AR aging (June 2026)" });
assert.equal(r.status, 200);
const single = f.requests.find((x) => x.text === "Most recent AR aging (June 2026)")!;

// Room access: Blind CIM may ask (once); a teaser link never; a buyer with the room → 409.
r = await call("POST", "/api/view/tok-blind-aaaaaaaaa/data-room/requests", { kind: "room_access" });
assert.equal(r.status, 200, JSON.stringify(r.json));
r = await call("POST", "/api/view/tok-blind-aaaaaaaaa/data-room/requests", { kind: "room_access" });
assert.equal(r.json.already, true);
assert.equal(f.requests.filter((x) => x.kind === "room_access").length, 1);
assert.equal((await call("POST", "/api/view/tok-teaser-aaaaaaaa/data-room/requests", { kind: "room_access" })).status, 403, "teaser links never ask for the room (C23)");
assert.equal((await call("POST", `${B}/requests`, { kind: "room_access" })).status, 409);
assert.equal((await call("POST", "/api/view/tok-blind-aaaaaaaaa/data-room/requests", { text: "A document" })).status, 403, "no room → no document request");

// The buyer's own list ("Your requests").
let room = await call("GET", B);
assert.equal(room.json.requests.length, 5);
assert.ok(room.json.requests.every((x: any) => x.statusText === "Waiting for the broker"));
assert.equal(room.json.canRequest, true);

// ── The broker: the list, Waiting on you, the KPI ──
let reqs = await call("GET", `${R}/requests`, undefined, "b1");
assert.equal(reqs.status, 200);
assert.equal(reqs.json.lists.length, 1);
assert.equal(reqs.json.lists[0].count, 3);
assert.equal(reqs.json.lists[0].buyerLabel, "Northgate");
const cited = reqs.json.requests.find((x: any) => x.text === "Tax return 2023");
assert.equal(cited.citedDocument.name, "Warehouse lease", "the broker sees which document a citation pointed at");
let todo = await call("GET", `${R}/todo`, undefined, "b1");
const kinds = todo.json.items.map((x: any) => x.kind);
assert.equal(kinds.filter((k: string) => k === "request").length, 4, "the pasted list is one row (+2 singles +1 access)");
assert.ok(todo.json.items.some((x: any) => /sent a list of 3 requests/.test(x.text)));
assert.ok(todo.json.items.some((x: any) => /asked for access to the data room/.test(x.text)));
let roomPayload = await call("GET", R, undefined, "b1");
assert.equal(roomPayload.json.kpis.waiting, todo.json.items.length, "the KPI counts the same list");

// Tenancy.
assert.equal((await call("PATCH", `${R}/requests/${single.id}`, { action: "decline" }, "b2")).status, 404, "another brokerage");
const eReq = (await f.store.insertRequests([{ dealId: "E", buyerAccessId: "E-dd", buyerEmail: "x@e.invalid", kind: "document", text: "x", status: "open" }]))[0];
assert.equal((await call("PATCH", `${R}/requests/${eReq.id}`, { action: "decline" }, "b1")).status, 404, "another deal's request");
assert.equal((await call("POST", `${R}/requests/bulk`, { action: "decline", requestIds: [single.id, eReq.id] }, "b1")).status, 404);

// Ask the seller (single, with a note and a date).
r = await call("PATCH", `${R}/requests/${single.id}`, { action: "ask_seller", requirementName: "AR aging (June 2026)", requirementNote: "The most recent month is enough", neededBy: "2026-10-20" }, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
const reqRow = app.requirements.find((x) => x.id === r.json.requirementIds[0])!;
assert.equal(reqRow.source, "buyer_request");
assert.equal(reqRow.isRequired, true);
assert.equal(reqRow.category, "financial");
assert.equal(reqRow.documentName, "AR aging (June 2026)");
assert.equal(reqRow.notes, "The most recent month is enough");
assert.equal(new Date(reqRow.neededBy).toISOString().slice(0, 10), "2026-10-20");
assert.ok(!JSON.stringify(reqRow).includes("Northgate") && !JSON.stringify(reqRow).toLowerCase().includes("jane"), "the seller never sees who asked");
assert.equal(f.requests.find((x) => x.id === single.id).status, "asked_seller");
assert.equal((await call("PATCH", `${R}/requests/${single.id}`, { action: "ask_seller" }, "b1")).status, 409, "asked once");

// Bulk: the pasted list → three rows, then ONE email for everything asked in the last minutes.
r = await call("POST", `${R}/requests/bulk`, { action: "ask_seller", requestIds: listRows.map((x) => x.id), neededBy: "2026-10-25" }, "b1");
assert.equal(r.json.asked, 3);
reqs = await call("GET", `${R}/requests`, undefined, "b1");
assert.equal(reqs.json.sellerEmail.unsent.length, 4, "four asks not emailed yet");
r = await call("POST", `${R}/requests/email-seller`, { requirementIds: [r.json.requirementIds[0]] }, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.count, 4, "the other recent asks go in the same email");
assert.equal(app.sellerEmails.length, 1, "one email");
assert.equal(app.sellerEmails[0].event, "seller_document_request");
assert.equal(app.sellerEmails[0].path, "documents");
assert.match(app.sellerEmails[0].title, /added 4 documents/);
reqs = await call("GET", `${R}/requests`, undefined, "b1");
assert.equal(reqs.json.sellerEmail.unsent.length, 0);
assert.ok(reqs.json.sellerEmail.lastAt);
const eReqRow = { id: "E-req", dealId: "E", source: "buyer_request", documentName: "x", status: "missing", createdAt: now };
app.requirements.push(eReqRow);
assert.equal((await call("POST", `${R}/requests/email-seller`, { requirementIds: ["E-req"] }, "b1")).status, 404, "another deal's checklist row");

// The seller uploads the AR aging → Ready to share → one click shares it with Northgate only.
docs.push({ id: "ar", dealId: "D", name: "AR aging June 2026", originalName: "ar.pdf", category: "financials", fileUrl: "/uploads/docs/ar.pdf", mimeType: "application/pdf", createdAt: now, uploadedBy: "seller", sourceKind: "document", visibility: "shared", subcategory: null });
f.documents.push(docs[docs.length - 1]);
assert.equal(await onRequirementFulfilled(reqRow.id, "ar", f.store), 1);
assert.equal(f.requests.find((x) => x.id === single.id).status, "ready_to_share");
todo = await call("GET", `${R}/todo`, undefined, "b1");
const ready = todo.json.items.find((x: any) => x.kind === "request_ready");
assert.match(ready.text, /The seller uploaded 'AR aging June 2026' that Northgate asked for/);
r = await call("POST", `${R}/requests/${single.id}/share-and-tell`, {}, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.draft.subject, "The document you asked for is in the data room");
assert.match(r.json.draft.message, /'AR aging June 2026', is now in the data room/);
assert.deepEqual(r.json.draft.to, ["Northgate"]);
const arItem = itemOf("ar");
for (const it of [arItem]) {
  it.prepared = { status: "ready", kind: "image", forFile: "0123456789abcdef", pages: [{ w: 100, h: 140, hasText: true }] };
  fs.mkdirSync(vdrCacheDir("D", it.id, "0123456789abcdef", root)!, { recursive: true });
  fs.writeFileSync(path.join(vdrCacheDir("D", it.id, "0123456789abcdef", root)!, "p1.webp"), "webp");
}
assert.deepEqual(f.shares.filter((s) => s.itemId === arItem.id).map((s) => [s.audience, s.buyerEmail, s.effect]), [["buyer", "jane@northgate.invalid", "allow"]], "only the buyer who asked");
assert.equal(f.requests.find((x) => x.id === single.id).status, "shared");
room = await call("GET", B);
const mine = room.json.requests.find((x: any) => x.text === "Most recent AR aging (June 2026)");
assert.match(mine.statusText, /^Shared: now in \d/);
assert.ok(room.json.items.some((x: any) => x.id === arItem.id), "Northgate can open it");

// Tell the buyer: sent with their own data-room link, reply-to the broker.
r = await call("POST", `${R}/requests/${single.id}/tell-buyer`, { subject: "It's in", message: "The AR aging is in the data room." }, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.sent, 1);
assert.equal(app.buyerEmails.length, 1);
assert.equal(app.buyerEmails[0].to, "Jane@Northgate.invalid");
assert.ok(app.buyerEmails[0].html.includes("/view/tok-dd-aaaaaaaaaaaa/data-room?doc="), "their own link, opening the document");
assert.ok(f.activity.some((a) => a.action === "told_buyer"));

// Decline with a note: the buyer reads it.
const eqp = listRows.find((x) => x.text === "Equipment leases")!;
f.requests.find((x) => x.id === eqp.id).status = "open";
r = await call("PATCH", `${R}/requests/${eqp.id}`, { action: "decline", note: "The seller has no equipment leases; everything is owned." }, "b1");
assert.equal(r.status, 200);
room = await call("GET", B);
assert.equal(room.json.requests.find((x: any) => x.text === "Equipment leases").statusText, "The broker replied: 'The seller has no equipment leases; everything is owned.'");

// Room access: a Blind CIM buyer must be moved first (409 blind); a Full CIM buyer gets it.
const accessReq = f.requests.find((x) => x.kind === "room_access")!;
r = await call("PATCH", `${R}/requests/${accessReq.id}`, { action: "grant_room" }, "b1");
assert.equal(r.status, 409);
assert.equal(r.json.code, "blind");
access.find((a) => a.id === "blind").accessLevel = "named";
r = await call("PATCH", `${R}/requests/${accessReq.id}`, { action: "grant_room" }, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(f.settings.find((s) => s.buyerEmail === "bo@blind.invalid").roomAccess, "on");
assert.equal((await call("GET", "/api/view/tok-blind-aaaaaaaaa/data-room")).status, 200, "the room opens for them now");

// Let them know (after a share): only buyers who can open it; demo deals never send.
r = await call("POST", `${R}/let-buyers-know/draft`, { itemIds: [itemOf("t2").id], accessIds: ["dd", "blind"] }, "b1");
assert.equal(r.status, 200);
assert.deepEqual(r.json.to, ["Northgate"], "BlindCo (now Full CIM) can't open the T2: not emailed");
assert.match(r.json.subject, /New documents in the data room for Pacific Test Logistics/);
assert.equal((await call("POST", `${R}/let-buyers-know/draft`, { itemIds: [itemOf("t2").id], accessIds: ["E-dd"] }, "b1")).status, 404, "another deal's link");
deals[0].demoKey = "pacific-demo";
const before = app.buyerEmails.length;
r = await call("POST", `${R}/let-buyers-know`, { itemIds: [itemOf("t2").id], accessIds: ["dd"], subject: "New documents", message: "Have a look." }, "b1");
assert.equal(r.json.demo, true);
assert.equal(app.buyerEmails.length, before, "an example deal records, never sends");
assert.ok(f.activity.some((a) => a.action === "buyers_emailed" && a.detail?.demo === true));

// The broker's own preview never sends a request.
assert.equal((await fetch(`${app.base}${B}/requests`, { method: "POST", headers: { "content-type": "application/json", "x-test-broker": "b1" }, body: JSON.stringify({ text: "x" }) })).status, 403);

app.close();
console.log("vdr-requests: all passed");
