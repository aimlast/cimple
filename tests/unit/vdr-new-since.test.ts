/**
 * vdr spec §4.4: "New since your last visit" and "Updated".
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-new-since.test.ts
 *
 *  - no previous visit → nothing badged; a visit rolls only after 30 minutes away
 *  - New = a grant that applies to THIS reader created after their previous visit
 *    (a grant to another buyer, or a hidden one, doesn't count)
 *  - Updated = the file changed after the previous visit AND they opened an earlier version
 *  - the room payload rolls the stamps and logs one "opened the room" per visit;
 *    the view room's header count agrees.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-new-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";

const { isNewForBuyer, rollVisitStamps } = await import("../../shared/vdr");
const { vdrBuyerGate, decideForGate } = await import("../../server/vdr/access");
const { buyerRoomPayload } = await import("../../server/vdr/buyer-room");
const { viewRoomDataRoom } = await import("../../server/routes/data-room-buyer");
const { fakeVdrStore } = await import("./vdr-fake-store");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");

// ── Pure rules ──
const t = (s: string) => new Date(`2026-10-0${s}Z`);
assert.deepEqual(isNewForBuyer({ grants: [{ createdAt: t("5T10:00:00") }], previousVisitAt: null, fileChangedAt: null, openedEarlierVersion: false }), { isNew: false, isUpdated: false }, "first visit: nothing badged");
assert.deepEqual(isNewForBuyer({ grants: [{ createdAt: t("5T10:00:00") }], previousVisitAt: t("4T10:00:00"), fileChangedAt: null, openedEarlierVersion: false }), { isNew: true, isUpdated: false });
assert.deepEqual(isNewForBuyer({ grants: [{ createdAt: t("3T10:00:00") }], previousVisitAt: t("4T10:00:00"), fileChangedAt: t("5T10:00:00"), openedEarlierVersion: true }), { isNew: false, isUpdated: true });
assert.deepEqual(isNewForBuyer({ grants: [{ createdAt: t("3T10:00:00") }], previousVisitAt: t("4T10:00:00"), fileChangedAt: t("5T10:00:00"), openedEarlierVersion: false }), { isNew: false, isUpdated: false }, "never opened before → not 'updated'");
const r1 = rollVisitStamps({ lastVisitAt: t("5T10:00:00"), previousVisitAt: t("4T10:00:00") }, t("5T10:20:00"));
assert.equal(r1.rolled, false, "20 minutes later is the same visit");
assert.equal(r1.previousVisitAt!.toISOString(), t("4T10:00:00").toISOString());
const r2 = rollVisitStamps({ lastVisitAt: t("5T10:00:00"), previousVisitAt: t("4T10:00:00") }, t("5T11:00:00"));
assert.equal(r2.rolled, true);
assert.equal(r2.previousVisitAt!.toISOString(), t("5T10:00:00").toISOString());

// ── The room payload ──
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
for (const n of ["a.pdf", "b.pdf", "c.pdf"]) fs.writeFileSync(path.join(root, "docs", n), "x");
const at = new Date("2026-10-01T00:00:00Z");
const f = fakeVdrStore({ documents: [
  { id: "a", dealId: "D", name: "T2 2023", originalName: "a.pdf", category: "financials", fileUrl: "/uploads/docs/a.pdf", mimeType: "application/pdf", createdAt: at },
  { id: "b", dealId: "D", name: "Financial statements FY2023", originalName: "b.pdf", category: "financials", fileUrl: "/uploads/docs/b.pdf", mimeType: "application/pdf", createdAt: at },
  { id: "c", dealId: "D", name: "Warehouse lease", originalName: "c.pdf", category: "legal", fileUrl: "/uploads/docs/c.pdf", mimeType: "application/pdf", createdAt: at },
] });
let clock = new Date("2026-10-05T09:00:00Z");
await setUpRoom("D", "b1", "auto", { store: f.store, enqueue: () => {}, now: () => clock });
for (const it of f.items) {
  it.prepared = { status: "ready", kind: "pdf", forFile: "0123456789abcdef", fileHash: "h1", pages: [{ w: 1, h: 1, hasText: true }] };
  fs.mkdirSync(vdrCacheDir("D", it.id, "0123456789abcdef", root)!, { recursive: true });
}
const item = (doc: string) => f.items.find((i) => i.documentId === doc)!;
const share = (doc: string, createdAt: Date, extra: any = {}) => f.shares.push({ id: `s${f.shares.length}`, dealId: "D", itemId: item(doc).id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdAt, ...extra });
share("a", new Date("2026-10-02T00:00:00Z"));
share("b", new Date("2026-10-02T00:00:00Z"));
const deal = { id: "D", brokerId: "b1", businessName: "Test Co", isLive: true, extractedInfo: {} };
const access = [{ id: "dd", dealId: "D", buyerEmail: "jane@n.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: null, createdAt: at }];
const deps = { store: f.store, accessByToken: async (tk: string) => access.find((a) => a.accessToken === tk), accessRowsForDeal: async () => access, getDeal: async () => deal, now: () => clock, root };
const room = async () => {
  const gate = await vdrBuyerGate(deps as any, "tok-dd-xxxxxxxxx");
  const { snap, decided } = await decideForGate(deps as any, gate);
  return buyerRoomPayload({ store: f.store, brand: async () => ({ firmName: null, logoUrl: null }), now: () => clock }, gate, snap, decided);
};

// First visit: nothing new.
let p = await room();
assert.equal(p.items.length, 2);
assert.equal(p.newCount, 0);
assert.equal(p.previousVisitAt, null);
assert.equal(f.activity.filter((a) => a.action === "buyer_opened_room").length, 1);
// 10 minutes later: same visit, no new log line.
clock = new Date("2026-10-05T09:10:00Z");
p = await room();
assert.equal(f.activity.filter((a) => a.action === "buyer_opened_room").length, 1, "one log line per visit");

// The broker shares the lease (to due diligence) and something only for ANOTHER buyer, and hides one from Jane.
share("c", new Date("2026-10-06T00:00:00Z"));
f.shares.push({ id: "other", dealId: "D", itemId: item("b").id, audience: "buyer", accessLevel: null, buyerEmail: "someone@else.invalid", effect: "allow", createdAt: new Date("2026-10-06T00:00:00Z") });
// The statements' file changes (a cleaned copy) after Jane opened the earlier version.
f.views.push({ id: "v1", dealId: "D", buyerAccessId: "dd", buyerEmail: "jane@n.invalid", teamMemberId: null, itemId: item("b").id, fileVersion: 1, trace: "AAAAAA", source: "room", startedAt: clock, lastSeenAt: clock, activeMs: 1000, pageMs: {}, maxPage: 1, downloaded: false });
item("b").fileVersion = 2;
item("b").fileChangedAt = new Date("2026-10-06T00:00:00Z");

// The view room's header count (before entering the room) agrees with what the room will show.
clock = new Date("2026-10-07T09:00:00Z");
const header = await viewRoomDataRoom("tok-dd-xxxxxxxxx", deps as any);
assert.equal(header?.available, true);
assert.equal(header?.newCount, 2, "the lease (new) + the statements (updated)");

p = await room();
const byTitle = Object.fromEntries(p.items.map((i) => [i.title, i]));
assert.equal(byTitle["Warehouse lease"].isNew, true);
assert.equal(byTitle["Financial statements FY2023"].isNew, false, "a grant to another buyer isn't new for Jane");
assert.equal(byTitle["Financial statements FY2023"].isUpdated, true);
assert.equal(byTitle["T2 2023"].isNew, false);
assert.equal(p.newCount, 2);
assert.equal(p.previousVisitAt, "2026-10-05T09:10:00.000Z");
assert.equal(f.activity.filter((a) => a.action === "buyer_opened_room").length, 2);

// Hidden from Jane: gone from the list (not "new").
f.shares.push({ id: "deny", dealId: "D", itemId: item("c").id, audience: "buyer", accessLevel: null, buyerEmail: "jane@n.invalid", effect: "deny", createdAt: new Date("2026-10-07T10:00:00Z") });
clock = new Date("2026-10-07T09:05:00Z");
p = await room();
assert.ok(!p.items.some((i) => i.title === "Warehouse lease"));

console.log("vdr-new-since: all passed");
