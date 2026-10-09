/**
 * vdr spec §4.5 / V13: one numbering for everyone; a buyer sees the same
 * numbers with what they can't open left out (never renumbered).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-index.test.ts
 */
import assert from "node:assert/strict";
import { indexNumbers, visibleTree, folderDepth, isNewForBuyer, rollVisitStamps, VDR_LIMITS } from "../../shared/vdr";

const folders = [
  { id: "fin", parentId: null, position: 1, name: "Financial" },
  { id: "legal", parentId: null, position: 2, name: "Legal & corporate" },
  { id: "other", parentId: null, position: 3, name: "Other documents" },
  { id: "stat", parentId: "fin", position: 1, name: "Financial statements" },
  { id: "tax", parentId: "fin", position: 2, name: "Tax returns" },
  { id: "tax-sub", parentId: "tax", position: 1, name: "Schedules" },
];
const items = [
  { id: "t22", folderId: "tax", position: 1, title: "T2 2022" },
  { id: "t23", folderId: "tax", position: 2, title: "T2 2023" },
  { id: "t24", folderId: "tax", position: 3, title: "T2 2024" },
  { id: "s23", folderId: "stat", position: 1, title: "Statements 2023" },
  { id: "fin-loose", folderId: "fin", position: 1, title: "Loose financial file" },
  { id: "gone", folderId: "tax", position: 0, title: "Tombstone", removedAt: new Date() },
  { id: "lease", folderId: "legal", position: 1, title: "Lease" },
];

const n = indexNumbers(folders, items);
assert.equal(n.folders.get("fin"), "1");
assert.equal(n.folders.get("legal"), "2");
assert.equal(n.folders.get("other"), "3");
assert.equal(n.folders.get("stat"), "1.1");
assert.equal(n.folders.get("tax"), "1.2");
assert.equal(n.items.get("fin-loose"), "1.3", "documents come after sub-folders, continuously");
assert.equal(n.folders.get("tax-sub"), "1.2.1", "a sub-folder first");
assert.equal(n.items.get("t22"), "1.2.2");
assert.equal(n.items.get("t23"), "1.2.3");
assert.equal(n.items.get("t24"), "1.2.4");
assert.equal(n.items.get("s23"), "1.1.1");
assert.equal(n.items.get("lease"), "2.1");
assert.equal(n.items.has("gone"), false, "tombstones get no number");

// Reorder renumbers for everyone.
const reordered = items.map((i) => (i.id === "t24" ? { ...i, position: 0 } : i));
const n2 = indexNumbers(folders, reordered);
assert.equal(n2.items.get("t24"), "1.2.2");
assert.equal(n2.items.get("t22"), "1.2.3");

// The buyer's tree: only what they can open and the folders that contain it; numbers unchanged.
const tree = visibleTree(folders, items, new Set(["t22", "t24", "lease"]));
assert.deepEqual(tree.items.map((i) => i.id).sort(), ["lease", "t22", "t24"]);
assert.deepEqual(tree.folders.map((f) => f.id).sort(), ["fin", "legal", "tax"], "empty and hidden-only folders are not shown");
assert.equal(n.items.get("t22"), "1.2.2");
assert.equal(n.items.get("t24"), "1.2.4", "the buyer sees 1.2.2 and 1.2.4; the hidden 1.2.3 is never named");
assert.deepEqual(visibleTree(folders, items, new Set(["gone"])).items, [], "a tombstone is never visible");

// Depth limit and cycles.
assert.equal(folderDepth(folders, "tax-sub"), 3);
assert.equal(VDR_LIMITS.folderDepth, 3);
assert.equal(folderDepth([{ id: "a", parentId: "b", position: 1, name: "a" }, { id: "b", parentId: "a", position: 1, name: "b" }], "a"), Infinity);

// New since your last visit (§4.4).
const prev = new Date("2026-10-03T10:00:00Z");
assert.deepEqual(isNewForBuyer({ grants: [{ createdAt: new Date("2026-10-04") }], previousVisitAt: prev, fileChangedAt: null, openedEarlierVersion: false }), { isNew: true, isUpdated: false });
assert.deepEqual(isNewForBuyer({ grants: [{ createdAt: new Date("2026-10-01") }], previousVisitAt: prev, fileChangedAt: new Date("2026-10-05"), openedEarlierVersion: true }), { isNew: false, isUpdated: true });
assert.deepEqual(isNewForBuyer({ grants: [{ createdAt: new Date("2026-10-01") }], previousVisitAt: prev, fileChangedAt: new Date("2026-10-05"), openedEarlierVersion: false }), { isNew: false, isUpdated: false }, "updated only if they had opened it");
assert.deepEqual(isNewForBuyer({ grants: [{ createdAt: new Date("2026-10-04") }], previousVisitAt: null, fileChangedAt: null, openedEarlierVersion: false }), { isNew: false, isUpdated: false }, "first visit: nothing badged");
const t0 = new Date("2026-10-09T10:00:00Z");
assert.deepEqual(rollVisitStamps({ lastVisitAt: null, previousVisitAt: null }, t0), { lastVisitAt: t0, previousVisitAt: null, rolled: true });
const soon = new Date(t0.getTime() + 10 * 60_000);
assert.equal(rollVisitStamps({ lastVisitAt: t0, previousVisitAt: prev }, soon).previousVisitAt, prev, "within 30 minutes the visit continues");
const later = new Date(t0.getTime() + 31 * 60_000);
assert.equal(rollVisitStamps({ lastVisitAt: t0, previousVisitAt: prev }, later).previousVisitAt, t0, "a new visit rolls the stamps");

console.log("vdr index: ok");
