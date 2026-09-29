// F2-DI-4 round 2: removing a buyer who stays listed through deal access
// clears the broker's notes and edits ("Add back" restores them). A later
// tag / note / interest / profile edit revives the removal row — it used to
// bring the cleared notes and overlay quietly back; now it starts fresh.
// The database is a stub: ensureContact's reads and its one write are queued.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-buyer-readd.test.ts
import assert from "node:assert/strict";
import { db } from "../../server/db";
import { ensureContact, SET_ASIDE_BROKER_EDITS_CLEARED } from "../../server/buyers/profile-data";

const removedRow = {
  id: "c1", brokerId: "b", buyerUserId: "u", source: "manual", tags: ["vip"], notes: "old note", interestStatus: "hot",
  brokerProfile: { background: "old edit" }, brokerProfileMeta: { background: { at: "x" } }, aiSummary: { text: "old" },
  crmProfile: { background: "from CRM" }, removedAt: new Date(),
};
const selects: unknown[][] = [];
const writes: any[] = [];
const chain = (rows: unknown[]) => {
  const c: any = { from: () => c, where: () => c, orderBy: () => Promise.resolve(rows), then: (f: any, r: any) => Promise.resolve(rows).then(f, r) };
  return c;
};
(db as any).select = () => chain(selects.shift() ?? []);
(db as any).update = () => ({ set: (patch: any) => ({ where: () => ({ returning: () => { writes.push(patch); return Promise.resolve([{ ...removedRow, ...patch }]); } }) }) });
(db as any).insert = () => { throw new Error("no second row may be created"); };

// No active row; a removal row → revived, without the set-aside edits.
selects.push([], [removedRow]);
const c = await ensureContact("b", "u");
assert.equal(c.id, "c1", "the removal row comes back (never a second row)");
assert.equal(c.removedAt, null);
assert.equal(c.notes, null, "the cleared note doesn't come back");
assert.deepEqual(c.tags, []);
assert.equal(c.interestStatus, null);
assert.equal(c.brokerProfile, null, "the cleared profile edits don't come back");
assert.equal(c.brokerProfileMeta, null);
assert.equal(c.aiSummary, null);
assert.deepEqual((c as any).crmProfile, { background: "from CRM" }, "CRM data (not the broker's edits) is left as it is");
assert.deepEqual(writes[0], { removedAt: null, ...SET_ASIDE_BROKER_EDITS_CLEARED, updatedAt: writes[0].updatedAt });
console.log("✓ a new edit on a removed (still listed) buyer starts fresh — the notes and edits the broker removed stay removed");

// An active row is used as it is.
selects.push([{ ...removedRow, id: "c2", removedAt: null }]);
const d = await ensureContact("b", "u");
assert.equal(d.id, "c2");
assert.equal(d.notes, "old note");
assert.equal(writes.length, 1, "nothing written for an active row");
console.log("✓ an active row is used as it is");

console.log("f2-buyer-readd: all passed");
process.exit(0);
