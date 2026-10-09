/**
 * vdr spec §9.3: vdrBuyerGate with injected deps — every refusal and its
 * words, no isLive dependency (V3), team-member links (V18), and the
 * held-back rule for a shared document Cimple found needs a look.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-gate.test.ts
 */
import assert from "node:assert/strict";

const { fakeVdrStore } = await import("./vdr-fake-store");
const { vdrBuyerGate, gateForLink, tokenHash, VdrHttpError, decideItems } = await import("../../server/vdr/access");

const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-01T00:00:00Z");
const f = fakeVdrStore();
const deal: any = { id: "D", brokerId: "b1", businessName: "Pacific Test", isLive: false };
const rows: any[] = [
  { id: "dd", dealId: "D", buyerEmail: "Jane@N.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "named", dealId: "D", buyerEmail: "sam@f.invalid", buyerName: "Sam", accessToken: "tok-named-xxxxx", accessLevel: "loi", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "blind", dealId: "D", buyerEmail: "bo@b.invalid", accessToken: "tok-blind-xxxxx", accessLevel: "full", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "teaser", dealId: "D", buyerEmail: "t@t.invalid", accessToken: "tok-teaser-xxxx", accessLevel: "teaser_only", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "nonda", dealId: "D", buyerEmail: "n@n.invalid", accessToken: "tok-nonda-xxxxx", accessLevel: "due_diligence", ndaSigned: false, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "revoked", dealId: "D", buyerEmail: "r@r.invalid", accessToken: "tok-revoked-xxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: now, expiresAt: later, createdAt: now },
  { id: "expired", dealId: "D", buyerEmail: "e@e.invalid", accessToken: "tok-expired-xxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: new Date("2026-10-01"), createdAt: now },
];
const deps = {
  store: f.store,
  accessByToken: async (t: string) => rows.find((r) => r.accessToken === t),
  accessRowsForDeal: async (d: string) => rows.filter((r) => r.dealId === d),
  getDeal: async (id: string) => (id === "D" ? deal : undefined),
  now: () => now,
  root: "/nonexistent",
};
async function refused(token: string, opts: any = {}) {
  try { await vdrBuyerGate(deps, token, opts); } catch (e) { if (e instanceof VdrHttpError) return { status: e.status, body: e.body }; throw e; }
  return null;
}

// No room yet.
assert.deepEqual(await refused("tok-dd-xxxxxxxx"), { status: 404, body: { code: "room_none", error: "The data room isn't open to you yet" } });
await f.store.ensureRoom({ dealId: "D", status: "open", autoAddNew: true });

// Links.
assert.deepEqual(await refused("nope-nope-nope"), { status: 404, body: { error: "Access denied or link expired" } });
assert.deepEqual(await refused("x"), { status: 404, body: { error: "Access denied or link expired" } });
assert.deepEqual(await refused("tok-revoked-xxx"), { status: 403, body: { error: "Access has been revoked" } });
assert.deepEqual(await refused("tok-expired-xxx"), { status: 403, body: { error: "Link has expired" } });
assert.deepEqual(await refused("tok-nonda-xxxxx"), { status: 403, body: { code: "nda_required", error: "Sign the NDA to open the data room" } });

// Levels: teaser and Blind CIM never; Full CIM only when turned on; DD automatic.
assert.equal((await refused("tok-teaser-xxxx"))?.body.code, "no_room_access");
assert.equal((await refused("tok-teaser-xxxx"))?.body.teaser, true, "a teaser link is told to go back to the summary (C23)");
assert.equal((await refused("tok-blind-xxxxx"))?.body.code, "no_room_access");
assert.equal((await refused("tok-blind-xxxxx"))?.body.teaser, false);
assert.equal((await refused("tok-named-xxxxx"))?.body.code, "no_room_access");
await f.store.upsertBuyerSettings("D", "sam@f.invalid", { roomAccess: "on" });
const named = await vdrBuyerGate(deps, "tok-named-xxxxx");
assert.equal(named.mode, "normal");
assert.equal(named.reader.accessLevel, "named", "the legacy loi key is read as Full CIM");
await f.store.upsertBuyerSettings("D", "bo@b.invalid", { roomAccess: "on" });
assert.equal((await refused("tok-blind-xxxxx"))?.body.code, "no_room_access", "a Blind CIM link never gets the room, even switched on (V4)");

// Due diligence: automatic, and NOT tied to the CIM being live (V3).
assert.equal(deal.isLive, false);
const dd = await vdrBuyerGate(deps, "tok-dd-xxxxxxxx");
assert.equal(dd.mode, "dd");
assert.equal(dd.reader.buyerEmail, "jane@n.invalid", "buyer key = lower-cased email (V17)");
assert.equal(dd.viewer.kind, "buyer");
await f.store.upsertBuyerSettings("D", "jane@n.invalid", { roomAccess: "off" });
assert.equal((await refused("tok-dd-xxxxxxxx"))?.body.code, "no_room_access", "the broker can switch it off");
await f.store.upsertBuyerSettings("D", "jane@n.invalid", { roomAccess: "auto" });

// Closed room.
await f.store.updateRoom("D", { status: "closed" });
assert.deepEqual(await refused("tok-dd-xxxxxxxx"), { status: 403, body: { code: "room_closed", error: "The data room is closed" } });
await f.store.updateRoom("D", { status: "open" });

// Team members: requested → 404; active without the acknowledgement → ack_required
// (except the room payload); acknowledged → the principal's room; principal gone → team_ended.
f.team.push({ id: "t1", dealId: "D", principalEmail: "jane@n.invalid", addedViaAccessId: "dd", name: "Priya", email: "priya@a.invalid", role: "accountant", status: "requested", tokenHash: tokenHash("team-token-1-xxxxx"), ackAt: null, ackName: null });
assert.equal((await refused("team-token-1-xxxxx"))?.status, 404);
f.team[0].status = "active";
assert.equal((await refused("team-token-1-xxxxx"))?.body.code, "ack_required");
const unacked = await vdrBuyerGate(deps, "team-token-1-xxxxx", { allowNoAck: true });
assert.equal(unacked.viewer.kind, "team");
f.team[0].ackAt = now;
f.team[0].ackName = "Priya Shah";
const team = await vdrBuyerGate(deps, "team-token-1-xxxxx");
assert.equal(team.access.id, "dd", "the principal's best live link");
assert.equal(team.mode, "dd");
assert.equal(team.viewer.name, "Priya Shah");
assert.equal(team.viewer.email, "priya@a.invalid");
assert.equal(team.reader.buyerEmail, "jane@n.invalid", "reads as the buyer they work for");
rows[0].revokedAt = now;
assert.deepEqual(await refused("team-token-1-xxxxx"), { status: 403, body: { code: "team_ended", error: "Northgate's access to this data room has ended" } });
rows[0].revokedAt = null;
f.team[0].status = "removed";
assert.equal((await refused("team-token-1-xxxxx"))?.status, 404);

// gateForLink (View as a buyer) runs the same checks.
await assert.rejects(gateForLink(deps, { access: rows[2], member: null, deal }), (e: any) => e.body.code === "no_room_access");
const preview = await gateForLink(deps, { access: rows[0], member: null, deal });
assert.equal(preview.reader.mode, "dd");

// Held back: a shared, ready document with an unticked needs-a-look flag is not served.
const snap = {
  folders: [{ id: "F", dealId: "D", parentId: null, name: "Financial", position: 1 }],
  items: [{ id: "I", dealId: "D", folderId: "F", documentId: "doc", title: "Payroll", position: 1, removedAt: null, checkedFlags: null, checkedForFile: null, prepared: { status: "ready", kind: "pdf", forFile: "aaaaaaaaaaaaaaaa", pages: [{ w: 1, h: 1, hasText: true }], personalRecords: true } }],
  shares: [{ id: "s", dealId: "D", itemId: "I", audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow" }],
  docs: new Map([["doc", { id: "doc", dealId: "D", name: "Payroll", visibility: "shared", sourceKind: "document", category: "financials", subcategory: null, fileUrl: "/uploads/docs/x.pdf" }]]),
} as any;
const decided = decideItems(snap, dd.reader, "/r", { fileExists: () => true });
assert.deepEqual(decided[0].visibility, { visible: false, reason: "held_for_check" });
snap.items[0].checkedFlags = ["staff_records"];
snap.items[0].checkedForFile = "aaaaaaaaaaaaaaaa";
assert.deepEqual(decideItems(snap, dd.reader, "/r", { fileExists: () => true })[0].visibility, { visible: true }, "visible once ticked");
snap.items[0].prepared = { ...snap.items[0].prepared, forFile: "bbbbbbbbbbbbbbbb" };
assert.equal((decideItems(snap, dd.reader, "/r", { fileExists: () => true })[0].visibility as any).reason, "held_for_check", "a new file needs a new tick");

console.log("vdr-gate: all passed");
