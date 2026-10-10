/**
 * Release fixes F5 + F6 (ux-journeys, Pacific copy):
 *  F5 — a "Private matters" tick given before a document was prepared (the
 *       demo seed; the broker's "I've checked it" on a "Getting it ready…"
 *       item) was stored with checked_for_file = NULL and never counted:
 *       once prepared, the T2 / statements / minute book were held_for_check
 *       and vanished from the DD buyer's room. Now the tick is recorded
 *       "before prepared", counts while preparing, and the first preparation
 *       carries it to the prepared file. A file changed later still needs a
 *       fresh tick; an unticked flag still holds the document back.
 *  F6 — a document shared with a DD buyer but not prepared yet resolved as
 *       `{ available: false }` (the lock chip "isn't in your data room yet")
 *       and nothing started preparing it. Now it resolves as openable with
 *       `preparing: true`, and the room / resolve calls queue its preparation.
 * In-memory store, fake render pool. No database, no AI, no email.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-early-tick-and-preparing.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-early-tick-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";
delete process.env.RESEND_API_KEY;

const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom } = await import("../../server/vdr/setup");
const { prepareItem } = await import("../../server/vdr/prepare");
const { VDR_TICK_BEFORE_PREPARED, tickFileFor, tickApplies, uncheckedLookFlags } = await import("../../shared/vdr");

const now = new Date("2026-10-10T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
for (const n of ["t2.pdf", "fs.pdf", "mb.pdf"]) fs.writeFileSync(path.join(root, "docs", n), `%PDF-1.4 fixture ${n}`);
const docs: any[] = [
  { id: "t2", dealId: "D", name: "T2 corporate income tax return 2023", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "fs", dealId: "D", name: "Financial statements FY2023", originalName: "FS.pdf", category: "financials", fileUrl: "/uploads/docs/fs.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "mb", dealId: "D", name: "Minute book", originalName: "MB.pdf", category: "legal", fileUrl: "/uploads/docs/mb.pdf", mimeType: "application/pdf", createdAt: now },
];
// Cimple kept something out of the CIM from every one of them → "Private matters" (needs a look).
const deals = [{
  id: "D", brokerId: "b1", businessName: "Harbour Test Logistics", isLive: true, demoKey: null,
  extractedInfo: { _brokerPrivateNotes: [
    { note: "A driver's possible departure — keep out of the CIM", documentId: "t2" },
    { note: "Shareholder loan terms — broker only", documentId: "fs" },
    { note: "A past dispute between the shareholders", documentId: "mb" },
  ] },
}];
const access: any[] = [
  { id: "dd", dealId: "D", buyerEmail: "jane@northgate.invalid", buyerName: "Jane Doe", buyerCompany: "Northgate", accessToken: "tok-dd-bbbbbbbbbbbb", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
];
const queued: string[] = [];
const app = await vdrTestApp({ root, docs, deals, access, now, enqueuePrepare: (id) => queued.push(id) });
const { f, call } = app;
await setUpRoom("D", "b1", "auto", { store: f.store, enqueue: () => {}, now: () => now });
const itemOf = (docId: string) => f.items.find((i: any) => i.documentId === docId && !i.removedAt)!;
for (const d of ["t2", "fs", "mb"]) {
  await f.store.insertShares([{ dealId: "D", itemId: itemOf(d).id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "demo-seed" }]);
}
const T = "/api/view/tok-dd-bbbbbbbbbbbb/data-room";
const B = "/api/deals/D/data-room";
const fakePool = { run: async () => ({ kind: "pdf", pages: [{ w: 612, h: 792, hasText: true }], pageTexts: [{ page: 1, label: "Page 1", text: "Total revenue 29,180,000" }], personal: { count: 0, kinds: [], pages: [] } }) };
const prepDeps = { store: f.store, pool: fakePool as any, root, ledgerStatus: async () => null, sheetSlot: async <T,>(fn: () => Promise<T>) => fn(), now: () => now };

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

try {
  await test("tickFileFor / tickApplies: early ticks count until the first preparation, then only for that file", () => {
    assert.equal(tickFileFor(null), VDR_TICK_BEFORE_PREPARED);
    assert.equal(tickFileFor({ status: "failed", forFile: "0000000000000000", kind: "pdf", errorCode: "file_missing" } as any), VDR_TICK_BEFORE_PREPARED, "file not found yet = not prepared");
    assert.equal(tickFileFor({ status: "pending", forFile: "abcdabcdabcdabcd", kind: "pdf" } as any), "abcdabcdabcdabcd");
    assert.equal(tickApplies(VDR_TICK_BEFORE_PREPARED, null), true);
    assert.equal(tickApplies(VDR_TICK_BEFORE_PREPARED, { status: "pending", forFile: "x" } as any), true);
    assert.equal(tickApplies(VDR_TICK_BEFORE_PREPARED, { status: "ready", forFile: "x" } as any), false, "a ready file needs the carried tick");
    assert.equal(tickApplies("x", { status: "ready", forFile: "x" } as any), true);
    assert.equal(tickApplies("x", { status: "ready", forFile: "y" } as any), false, "a changed file needs a fresh tick");
    assert.equal(tickApplies(null, null), false);
    const flags = [{ key: "private_matters", look: true, copy: "" }] as any;
    assert.deepEqual(uncheckedLookFlags(flags, { checkedFlags: ["private_matters"], checkedForFile: VDR_TICK_BEFORE_PREPARED }, null), []);
    assert.deepEqual(uncheckedLookFlags(flags, { checkedFlags: ["private_matters"], checkedForFile: null }, null), ["private_matters"], "the old NULL tick never counted");
  });

  await test("F6: shared but not prepared → openable with preparing:true (not the lock), and queued", async () => {
    const r = await call("GET", `${T}/resolve?documentIds=t2,fs,mb,unknown`);
    assert.equal(r.status, 200);
    for (const id of ["t2", "fs", "mb"]) {
      assert.equal(r.json.documents[id].available, true, id);
      assert.equal(r.json.documents[id].preparing, true, id);
      assert.equal(r.json.documents[id].itemId, itemOf(id).id);
    }
    assert.deepEqual(r.json.documents.unknown, { available: false });
    assert.deepEqual(new Set(queued), new Set(["t2", "fs", "mb"].map((d) => itemOf(d).id)), "resolve queues their preparation");
    queued.length = 0;
    const room = await call("GET", T);
    assert.equal(room.status, 200);
    assert.deepEqual(new Set(queued), new Set(["t2", "fs", "mb"].map((d) => itemOf(d).id)), "the room's list queues them too");
    // Opening one works before it's ready (the viewer waits).
    const about = await call("GET", `${T}/items/${itemOf("t2").id}`);
    assert.equal(about.status, 200);
    assert.equal(about.json.manifest.status, "pending");
  });

  await test("F5: the broker's tick on a 'Getting it ready…' item is kept and carried to the prepared file", async () => {
    const r = await call("POST", `${B}/items/${itemOf("t2").id}/checked`, { flags: ["private_matters"] }, "b1");
    assert.equal(r.status, 200, r.text);
    assert.equal(itemOf("t2").checkedForFile, VDR_TICK_BEFORE_PREPARED);
    // The seed writes the same (scripts/seed-demo-data-room.ts → tickFileFor(it.prepared)).
    Object.assign(itemOf("mb"), { checkedAt: now, checkedBy: "demo-seed", checkedFlags: ["private_matters"], checkedForFile: tickFileFor(itemOf("mb").prepared ?? null) });
    const broker = await call("GET", B, undefined, "b1");
    assert.equal(broker.status, 200);
    const listed = (broker.json.items ?? []) as any[];
    const row = (id: string) => listed.find((x) => x.id === itemOf(id).id);
    assert.ok(row("t2") && row("fs"), "the broker's room lists them");
    assert.deepEqual(row("t2").unchecked, [], "no longer under Needs a look");
    assert.ok(row("t2").checked, "shown as checked");
    assert.deepEqual(row("fs").unchecked, ["private_matters"], "the unticked one still needs a look");
    for (const d of ["t2", "fs", "mb"]) {
      const p = await prepareItem(itemOf(d).id, {}, prepDeps);
      assert.equal(p!.status, "ready", d);
    }
    assert.equal(itemOf("t2").checkedForFile, itemOf("t2").prepared.forFile, "carried to the prepared file");
    assert.equal(itemOf("mb").checkedForFile, itemOf("mb").prepared.forFile, "the seed's tick carried too");
    assert.equal(itemOf("fs").checkedForFile ?? null, null, "nothing invented for the unticked one");
  });

  await test("F5: after preparation the DD buyer keeps the ticked documents; the unticked one is still held", async () => {
    const r = await call("GET", `${T}/resolve?documentIds=t2,mb,fs`);
    assert.equal(r.json.documents.t2.available, true);
    assert.equal(r.json.documents.t2.preparing, undefined, "ready now");
    assert.equal(r.json.documents.mb.available, true);
    assert.deepEqual(r.json.documents.fs, { available: false }, "held for the broker's check (fail-closed)");
    const open = await call("GET", `${T}/items/${itemOf("t2").id}`);
    assert.equal(open.status, 200);
    assert.equal(open.json.manifest.status, "ready");
  });

  await test("F5: a later file change still needs a fresh tick", async () => {
    fs.writeFileSync(path.join(root, "docs", "t2.pdf"), "%PDF-1.4 fixture t2 — restated");
    const p = await prepareItem(itemOf("t2").id, {}, prepDeps);
    assert.notEqual(itemOf("t2").checkedForFile, p!.forFile);
    const r = await call("GET", `${T}/resolve?documentIds=t2`);
    assert.deepEqual(r.json.documents.t2, { available: false }, "held until the broker checks the new file");
  });

  await test("the seed and every route write ticks through tickFileFor", () => {
    const seed = fs.readFileSync(new URL("../../scripts/seed-demo-data-room.ts", import.meta.url), "utf8");
    assert.ok(seed.includes("checkedForFile: tickFileFor(it.prepared)"));
    const routes = fs.readFileSync(new URL("../../server/routes/data-room.ts", import.meta.url), "utf8");
    assert.equal((routes.match(/checkedForFile: tickFileFor\(/g) ?? []).length, 3, "plan, I've checked it, sharing");
    assert.ok(!/checkedForFile: (c\.)?(item|it)\.prepared\?\.forFile/.test(routes), "no route writes the raw forFile any more");
  });
} finally {
  app.close();
}
console.log(`vdr-early-tick-and-preparing: ${passed} passed`);
process.exit(0);
