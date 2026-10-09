/**
 * vdr spec §9.9 (V11): questions about a data-room document.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-qa-scope.test.ts
 *
 *  - a document question's answer is private to the asker by default; the
 *    broker can show it to the document's readers ("room") — never "all",
 *    whatever an older write left on the row (fail-closed)
 *  - both seller-approval routes keep that scope (approvalScope); a CIM
 *    question still becomes "all" on publish (unchanged behaviour)
 *  - another reader gets a "room" answer only while they can open that
 *    document right now (roomRowsFor + itemIdsVisibleToLink): never a
 *    teaser or Blind CIM reader, never after it's unshared or the room closes
 *  - the buyer's About panel lists their own questions and the shared answers
 *  - POST …/items/:itemId/questions: no AI, pending_broker, private, the page,
 *    the team member; hidden item → 404; the broker is alerted
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-qa-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";

const { rowScope, scopeAllows, readerMaySeeRow, vdrAnswerScope, approvalScope, roomRowsFor } = await import("../../shared/buyer-qa-scope");
const { itemIdsVisibleToLink, vdrBuyerGate, decideForGate, itemFor } = await import("../../server/vdr/access");
const { buyerAboutExtras } = await import("../../server/vdr/buyer-room");
const { fakeVdrStore } = await import("./vdr-fake-store");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");
const { vdrTestApp } = await import("./vdr-app-harness");

// ── Pure scope rules ──
const base = { buyerAccessId: "dd", question: "Why does line 9367 differ?", sellerApproved: true, brokerDraft: "Capital cost allowance.", publishedAnswer: "Capital cost allowance." };
assert.equal(rowScope({ ...base, vdrItemId: "I", answerScope: "all" }, "due_diligence"), "private", "a document question is never 'all', whatever the row says");
assert.equal(rowScope({ ...base, vdrItemId: "I", answerScope: null }, "due_diligence"), "private");
assert.equal(rowScope({ ...base, vdrItemId: "I", answerScope: "room" }, false), "room");
assert.equal(rowScope({ ...base, answerScope: null }, "due_diligence"), "all", "a CIM question approved by the seller is for everyone (unchanged)");
assert.equal(scopeAllows("room", { buyerAccessId: "dd" }, { id: "dd", accessLevel: "due_diligence" }), true, "the asker");
assert.equal(scopeAllows("room", { buyerAccessId: "dd" }, { id: "other", accessLevel: "due_diligence" }), false, "fail-closed: only the document check can admit others");
assert.equal(readerMaySeeRow({ ...base, vdrItemId: "I", answerScope: "room" }, "room", { id: "other", accessLevel: "due_diligence" }, []), false);
assert.equal(vdrAnswerScope(null, undefined), "private", "default: only the buyer who asked");
assert.equal(vdrAnswerScope("room", undefined), "room", "kept when the broker didn't say");
assert.equal(vdrAnswerScope("private", true), "room");
assert.equal(vdrAnswerScope("room", false), "private");
assert.deepEqual(approvalScope({ vdrItemId: "I", answerScope: "private" }), { answerScope: "private", addedToKnowledgeBase: false }, "seller approval keeps private");
assert.deepEqual(approvalScope({ vdrItemId: "I", answerScope: "room" }), { answerScope: "room", addedToKnowledgeBase: true });
assert.deepEqual(approvalScope({ vdrItemId: "I", answerScope: "all" }), { answerScope: "private", addedToKnowledgeBase: false }, "never 'all' for a document question");
assert.deepEqual(approvalScope({ vdrItemId: null, answerScope: "private" }), { answerScope: "all", addedToKnowledgeBase: true }, "a CIM question: unchanged behaviour");

const rows = [
  { id: "q-room", ...base, vdrItemId: "I1", answerScope: "room", isPublished: true },
  { id: "q-private", ...base, vdrItemId: "I1", answerScope: "private", isPublished: true },
  { id: "q-unapproved", ...base, sellerApproved: false, brokerDraft: null, vdrItemId: "I1", answerScope: "room", isPublished: true },
  { id: "q-unpublished", ...base, vdrItemId: "I1", answerScope: "room", isPublished: false },
  { id: "q-other-doc", ...base, vdrItemId: "I2", answerScope: "room", isPublished: true },
  { id: "q-cim", ...base, vdrItemId: null, answerScope: "all", isPublished: true },
];
assert.deepEqual(roomRowsFor(rows as any, "other", new Set(["I1"])).map((q) => q.id), ["q-room"], "published, approved, room-scoped, about a document they can open");
assert.deepEqual(roomRowsFor(rows as any, "other", new Set()).map((q) => q.id), [], "can't open the document → nothing");
assert.deepEqual(roomRowsFor(rows as any, "dd", new Set(["I1", "I2"])).map((q) => q.id), [], "the asker's own rows pass the normal way, not here");

// ── Who can open the document right now ──
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "t2.pdf"), "x");
const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
const docs = [{ id: "t2", dealId: "D", name: "T2 2023", originalName: "t2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now }];
const f = fakeVdrStore({ documents: docs });
await setUpRoom("D", "b1", "auto", { store: f.store, enqueue: () => {}, now: () => now });
const t2 = f.items[0];
t2.prepared = { status: "ready", kind: "image", forFile: "0123456789abcdef", pages: [{ w: 1, h: 1, hasText: true }] };
fs.mkdirSync(vdrCacheDir("D", t2.id, "0123456789abcdef", root)!, { recursive: true });
await f.store.insertShares([{ dealId: "D", itemId: t2.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "t" }]);
const deal: any = { id: "D", brokerId: "b1", businessName: "Test Co", isLive: true, extractedInfo: {} };
const link = (id: string, accessLevel: string, extra: any = {}) => ({ id, dealId: "D", buyerEmail: `${id}@x.invalid`, buyerName: id, buyerCompany: `${id} Co`, accessToken: `tok-${id}-xxxxxxxxxx`, accessLevel, ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now, ...extra });
const deps = { store: f.store, now: () => now, root };
assert.deepEqual(Array.from(await itemIdsVisibleToLink(deal, link("dd2", "due_diligence") as any, deps)), [t2.id], "another due-diligence buyer can open it");
assert.equal((await itemIdsVisibleToLink(deal, link("full", "named") as any, deps)).size, 0, "a Full CIM buyer without the room");
assert.equal((await itemIdsVisibleToLink(deal, link("blind", "full") as any, deps)).size, 0, "a Blind CIM buyer never");
assert.equal((await itemIdsVisibleToLink(deal, link("teaser", "teaser_only") as any, deps)).size, 0, "a teaser buyer never");
assert.equal((await itemIdsVisibleToLink(deal, link("rev", "due_diligence", { revokedAt: now }) as any, deps)).size, 0, "a revoked link");
assert.equal((await itemIdsVisibleToLink(deal, link("nonda", "due_diligence", { ndaSigned: false }) as any, deps)).size, 0, "no NDA");
await f.store.updateRoom("D", { status: "closed" });
assert.equal((await itemIdsVisibleToLink(deal, link("dd2", "due_diligence") as any, deps)).size, 0, "the room is closed");
await f.store.updateRoom("D", { status: "open" });
await f.store.replaceShares([{ itemId: t2.id, rows: [] }]);
assert.equal((await itemIdsVisibleToLink(deal, link("dd2", "due_diligence") as any, deps)).size, 0, "unshared → gone at once");
await f.store.insertShares([{ dealId: "D", itemId: t2.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "t" }]);

// ── The About panel's questions ──
const access = [link("dd", "due_diligence"), link("dd2", "due_diligence")];
const gateDeps = { ...deps, accessByToken: async (t: string) => access.find((a) => a.accessToken === t), accessRowsForDeal: async () => access, getDeal: async () => deal };
const questions: any[] = [
  { id: "mine-waiting", dealId: "D", buyerAccessId: "dd", question: "What is line 9367?", status: "pending_broker", isPublished: false, vdrItemId: t2.id, vdrPage: 3, vdrTeamMemberId: null, answerScope: "private", createdAt: now },
  { id: "mine-answered", dealId: "D", buyerAccessId: "dd", question: "Is this the filed copy?", status: "published", isPublished: true, publishedAnswer: "Yes.", brokerDraft: "Yes.", sellerApproved: true, vdrItemId: t2.id, vdrPage: null, vdrTeamMemberId: null, answerScope: "private", createdAt: now },
  { id: "theirs-room", dealId: "D", buyerAccessId: "dd2", question: "Schedule 8?", status: "published", isPublished: true, publishedAnswer: "CCA for the fleet.", brokerDraft: "CCA for the fleet.", sellerApproved: true, vdrItemId: t2.id, answerScope: "room", createdAt: now },
  { id: "theirs-private", dealId: "D", buyerAccessId: "dd2", question: "Our own strategy question", status: "published", isPublished: true, publishedAnswer: "Private.", brokerDraft: "Private.", sellerApproved: true, vdrItemId: t2.id, answerScope: "private", createdAt: now },
];
const gate = await vdrBuyerGate(gateDeps as any, "tok-dd-xxxxxxxxxx");
const { snap, decided } = await decideForGate(gateDeps as any, gate);
const one = itemFor(decided, t2.id);
const ex = await buyerAboutExtras({ questionsForDeal: async () => questions, servedSections: async () => [] }, gate, snap, decided, one, { preview: false });
assert.deepEqual(ex.questions!.map((q) => [q.id, q.mine, q.status, q.answer]), [
  ["mine-waiting", true, "waiting", null],
  ["mine-answered", true, "answered", "Yes."],
  ["theirs-room", false, "answered", "CCA for the fleet."],
], "own questions, plus answers the broker showed to the document's readers — never another buyer's private one");
assert.equal(ex.canAsk, true);
assert.equal((await buyerAboutExtras({ questionsForDeal: async () => questions, servedSections: async () => [] }, gate, snap, decided, one, { preview: true })).canAsk, false, "the broker's preview never asks");

// ── Asking, over HTTP ──
const app = await vdrTestApp({ root, docs, deals: [deal], access, now });
await setUpRoom("D", "b1", "auto", app.setupDeps);
const it = app.f.items[0];
it.prepared = { status: "ready", kind: "image", forFile: "0123456789abcdef", pages: [{ w: 1, h: 1, hasText: true }, { w: 1, h: 1, hasText: true }, { w: 1, h: 1, hasText: true }] };
fs.mkdirSync(vdrCacheDir("D", it.id, "0123456789abcdef", root)!, { recursive: true });
let r = await app.call("POST", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${it.id}/questions`, { question: "What is line 9367?", page: 3 });
assert.equal(r.status, 404, "not shared with them yet → 404");
await app.f.store.insertShares([{ dealId: "D", itemId: it.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "t" }]);
r = await app.call("POST", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${it.id}/questions`, { question: "What is line 9367?", page: 3 });
assert.equal(r.status, 200, JSON.stringify(r.json));
const q = app.questions.find((x) => x.id === r.json.id)!;
assert.deepEqual([q.status, q.answerScope, q.isPublished, q.vdrItemId, q.vdrPage, q.vdrTeamMemberId, q.aiAnswer], ["pending_broker", "private", false, it.id, 3, null, null], "no AI, private, the page");
assert.equal(app.alerts.length, 1, "the broker is alerted");
assert.equal((await app.call("POST", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${it.id}/questions`, { question: "x".repeat(1001) })).status, 400);
r = await app.call("POST", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${it.id}/questions`, { question: "Page 99?", page: 99 });
assert.equal(app.questions.find((x) => x.id === r.json.id)!.vdrPage, null, "a page that doesn't exist isn't recorded");
const about = await app.call("GET", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${it.id}`);
assert.equal(about.json.questions.length, 2);
assert.ok(app.f.activity.some((a) => a.action === "buyer_asked"));
app.close();

console.log("vdr-qa-scope: all passed");
