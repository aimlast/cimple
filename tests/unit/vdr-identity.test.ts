/**
 * vdr spec V17 / §4.10: per-buyer settings follow the PERSON (their email),
 * not the link. A buyer who gets a new link keeps what was hidden from them
 * and what was shared with them; a team member reads through the principal's
 * best live link and loses access the moment it ends.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-identity.test.ts
 */
import assert from "node:assert/strict";
import { buyerKey, itemVisibility, principalLinkFor, linkLive, hasRoomAccess, type VdrPrepared, type ShareLike } from "../../shared/vdr";

assert.equal(buyerKey("  Jane.Doe@Northgate.INVALID "), "jane.doe@northgate.invalid");
assert.equal(buyerKey(null), "");

const ready: VdrPrepared = { status: "ready", forFile: "0123456789abcdef", kind: "pdf" };
const doc = { dealId: "D", visibility: "shared", sourceKind: "document", category: "financials", subcategory: null, fileUrl: "/uploads/docs/doc_x.pdf" };
const see = (email: string, level: string, shares: ShareLike[]) =>
  itemVisibility({
    dealId: "D",
    reader: { dealId: "D", accessLevel: level, buyerEmail: email, mode: level === "due_diligence" ? "dd" : "normal" },
    item: { dealId: "D", removedAt: null, prepared: ready, isLedger: false },
    doc,
    servedFileExists: true,
    shares,
  });

// The broker hides document X from buyer@a.com (stored by key). The buyer gets a NEW link, email in another case.
const hiddenX: ShareLike[] = [
  { audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow" },
  { audience: "buyer", accessLevel: null, buyerEmail: buyerKey("buyer@a.com"), effect: "deny" },
];
assert.deepEqual(see("buyer@a.com", "due_diligence", hiddenX), { visible: false, reason: "excluded" });
assert.deepEqual(see("Buyer@A.com", "due_diligence", hiddenX), { visible: false, reason: "excluded" }, "new link, same person → still hidden");
assert.deepEqual(see("other@b.com", "due_diligence", hiddenX), { visible: true }, "other buyers unaffected");
// A per-buyer allow carries over the same way (and works for a Full CIM link with the room on).
const sharedWithA: ShareLike[] = [{ audience: "buyer", accessLevel: null, buyerEmail: buyerKey("buyer@a.com"), effect: "allow" }];
assert.deepEqual(see("BUYER@a.com", "named", sharedWithA), { visible: true });
// Room access setting is per buyer key (the same setting applies to every link of that person).
assert.equal(hasRoomAccess("named", "on"), true);
assert.equal(hasRoomAccess("named", "auto"), false);

// ── A team member reads through the principal's best live link ──
const now = new Date("2026-10-09T12:00:00Z");
const rows = [
  { id: "full-old", dealId: "D", buyerEmail: "jane@northgate.invalid", accessLevel: "named", ndaSigned: true, revokedAt: null, expiresAt: new Date("2026-11-01"), createdAt: new Date("2026-09-01") },
  { id: "dd", dealId: "D", buyerEmail: "Jane@Northgate.invalid", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: new Date("2026-11-08"), createdAt: new Date("2026-10-01") },
  { id: "unsigned", dealId: "D", buyerEmail: "jane@northgate.invalid", accessLevel: "due_diligence", ndaSigned: false, revokedAt: null, expiresAt: null, createdAt: new Date("2026-10-05") },
  { id: "blind", dealId: "D", buyerEmail: "jane@northgate.invalid", accessLevel: "blind", ndaSigned: true, revokedAt: null, expiresAt: null, createdAt: new Date("2026-10-06") },
  { id: "other", dealId: "D", buyerEmail: "bob@x.invalid", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: null, createdAt: new Date("2026-10-06") },
];
assert.equal(principalLinkFor(rows, "jane@northgate.invalid", "on", now)?.id, "dd", "due diligence before Full CIM; unsigned and blind links never");
assert.equal(principalLinkFor(rows, "jane@northgate.invalid", "auto", now)?.id, "dd", "auto: only the DD link has the room");
assert.equal(principalLinkFor(rows, "jane@northgate.invalid", "off", now), null, "room switched off for this buyer");
// The DD link is revoked → the Full CIM link carries on only if the broker turned the room on.
const revoked = rows.map((r) => (r.id === "dd" ? { ...r, revokedAt: new Date("2026-10-09T11:00:00Z") } : r));
assert.equal(principalLinkFor(revoked, "jane@northgate.invalid", "on", now)?.id, "full-old");
assert.equal(principalLinkFor(revoked, "jane@northgate.invalid", "auto", now), null, "the team member loses access at once");
// Expired links don't count.
const expired = rows.map((r) => ({ ...r, expiresAt: new Date("2026-10-01") }));
assert.equal(principalLinkFor(expired, "jane@northgate.invalid", "on", now), null);
assert.equal(linkLive({ revokedAt: null, expiresAt: null }, now), true);
assert.equal(linkLive({ revokedAt: null, expiresAt: now }, now), false, "expiring now is expired");

console.log("vdr identity: ok");
