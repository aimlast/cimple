/**
 * vdr spec §6.2, §9.3: searching the room.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-search.test.ts
 *
 *  - %, _ and \ are matched literally (escapeLike); 2–100 characters
 *  - the snippet shows the match in context
 *  - only documents the reader can open are searched: never an unshared,
 *    hidden or broker-only one, never a ledger (gl searches those), and the
 *    page text searched is the SERVED text (numbers already covered)
 */
import assert from "node:assert/strict";

const { escapeLike } = await import("../../server/vdr/store");
const { cleanQuery, snippet, searchRoom } = await import("../../server/vdr/search");
const { fakeVdrStore } = await import("./vdr-fake-store");

assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
assert.equal(escapeLike("plain"), "plain");
assert.equal(cleanQuery("a"), null);
assert.equal(cleanQuery("  ab  "), "ab");
assert.equal(cleanQuery("x".repeat(101)), null);
assert.equal(cleanQuery(42), null);
assert.equal(cleanQuery("rent   2024"), "rent 2024");

const s = snippet("The quick brown fox: Sales $29,180,000 for the year ended Dec 31, 2023 and more text after that.", "29,180");
assert.deepEqual(s.filter((p) => p.match).map((p) => p.text), ["29,180"]);
assert.ok(s[0].text.includes("Sales $"));
assert.deepEqual(snippet("no match here", "zzz"), [{ text: "no match here", match: false }]);
assert.ok(snippet("x".repeat(500) + "NEEDLE" + "y".repeat(500), "needle")[0].text.startsWith("…"), "trimmed with an ellipsis");

const f = fakeVdrStore();
const rows = [
  { id: "1", dealId: "D", itemId: "visible", forFile: "f", page: 3, label: "Page 3", text: "Sales $29,180,000; SIN •••-•••-286" },
  { id: "2", dealId: "D", itemId: "unshared", forFile: "f", page: 1, label: "Page 1", text: "Sales $29,180,000 secret" },
  { id: "3", dealId: "D", itemId: "ledger", forFile: "f", page: 1, label: "Page 1", text: "Sales 29,180,000 ledger" },
  { id: "4", dealId: "OTHER", itemId: "visible", forFile: "f", page: 1, label: "Page 1", text: "29,180 other deal" },
];
f.pageText.push(...rows);
const items = [
  { id: "visible", title: "T2 corporate tax return 2023", number: "1.2.1", searchable: true },
  { id: "ledger", title: "General ledger 2023", number: "1.4.1", searchable: false },
];
const hits = await searchRoom(f.store, "D", items, "29,180");
assert.deepEqual(hits.map((h) => [h.itemId, h.page, h.label]), [["visible", 3, "Page 3"]], "only the visible, non-ledger document of this deal");
const title = await searchRoom(f.store, "D", items, "tax return");
assert.deepEqual(title.map((h) => [h.itemId, h.label]), [["visible", "Title"]]);
const covered = await searchRoom(f.store, "D", items, "046 454");
assert.equal(covered.length, 0, "a covered number can't be found");
const percent = await searchRoom(f.store, "D", items, "%");
assert.equal(percent.length, 0);

console.log("vdr-search: all passed");
