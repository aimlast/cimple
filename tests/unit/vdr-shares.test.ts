/**
 * vdr spec §5.5, §9.2, §4.6, §11.2: sharing rules.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-shares.test.ts
 *
 *  - validateShares: foreign link 404; teaser and Blind CIM links 400;
 *    teaser/blind levels 400; a ledger to Full CIM (level or buyer) 409 with
 *    gl's words; a flagged document without its tick 409 check_first; deny
 *    with no allow is fine; rows stored by buyer key; legacy level keys stored
 *    as the registry's keys (C2).
 *  - bulk / folder share: per item, skipped items with plain reasons; a
 *    ledger keeps only the due-diligence level.
 *  - "Share with the same people" copies the replaced version's grants.
 *  - the sharing plan: unflagged documents in a "Due diligence buyers" folder
 *    get the level; a flagged one only when ticked; the folder's choice is
 *    kept as a hint; "Not yet" shares nothing.
 *  - shareSummary chips.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-shares-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";

const { validateShares, parseShareBody, LEDGER_DD_ONLY } = await import("../../server/vdr/broker-room");
const { shareSummary } = await import("../../shared/vdr");
const { shareLikeReplaced, markReplacement } = await import("../../server/vdr/setup");
const { vdrTestApp } = await import("./vdr-app-harness");

const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
const access: any[] = [
  { id: "dd", dealId: "D", buyerEmail: "Jane@N.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "named", dealId: "D", buyerEmail: "sam@f.invalid", buyerName: "Sam", buyerCompany: "FullCo", accessToken: "tok-named-xxxxxx", accessLevel: "loi", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "blind", dealId: "D", buyerEmail: "bo@b.invalid", accessToken: "tok-blind-xxxxxx", accessLevel: "full", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "teaser", dealId: "D", buyerEmail: "t@t.invalid", accessToken: "tok-teaser-xxxxx", accessLevel: "teaser_only", ndaSigned: false, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "nonda", dealId: "D", buyerEmail: "n@n.invalid", buyerName: "Nora", accessToken: "tok-nonda-xxxxxx", accessLevel: "loi", ndaSigned: false, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "other", dealId: "E", buyerEmail: "x@e.invalid", accessToken: "tok-other-xxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
];
const item: any = { id: "I", dealId: "D", prepared: { forFile: "aaaaaaaaaaaaaaaa" } };
const base = { dealId: "D", item, isLedger: false, unchecked: [] as any[], checkedFlags: [] as string[], accessRows: access, by: "b1", now };
const v = (input: any, extra: any = {}) => validateShares({ ...base, ...extra, input: parseShareBody(input)! });

// ── validateShares ──
assert.deepEqual((v({ allow: ["other"] }) as any).failure.status, 404, "another deal's link");
assert.deepEqual((v({ deny: ["other"] }) as any).failure.status, 404);
assert.equal((v({ allow: ["blind"] }) as any).failure.status, 400);
assert.equal((v({ allow: ["teaser"] }) as any).failure.status, 400);
assert.match((v({ allow: ["nonda"] }) as any).failure.body.error, /hasn't signed the NDA/);
assert.equal((v({ levels: ["teaser"] }) as any).failure.status, 400, "a teaser level can't have documents");
assert.equal((v({ levels: ["full"] }) as any).failure.status, 400, "legacy full = Blind CIM");
assert.equal((v({ levels: ["blind"] }) as any).failure.status, 400);
assert.equal((v({ levels: ["nonsense"] }) as any).failure.status, 400);
const loi = v({ levels: ["loi", "due_diligence"] }) as any;
assert.ok(loi.ok);
assert.deepEqual(loi.rows.map((r: any) => r.accessLevel), ["named", "due_diligence"], "legacy keys stored as the registry's (C2)");
const byKey = v({ allow: ["dd"], deny: ["named"] }) as any;
assert.ok(byKey.ok);
assert.deepEqual(byKey.rows.map((r: any) => [r.audience, r.buyerEmail, r.effect, r.viaAccessId]), [["buyer", "jane@n.invalid", "allow", "dd"], ["buyer", "sam@f.invalid", "deny", "named"]], "per-buyer rows by key (V17)");
assert.ok((v({ deny: ["dd"] }) as any).ok, "deny without an allow is allowed");
assert.equal((v({ allow: ["dd"], deny: ["dd"] }) as any).failure.status, 400, "allowed and hidden at once");
// Ledger: due diligence only (gl's ask 2).
assert.deepEqual((v({ levels: ["named"] }, { isLedger: true }) as any).failure, { status: 409, body: { code: "ledger_dd_only", error: LEDGER_DD_ONLY } });
assert.equal((v({ allow: ["named"] }, { isLedger: true }) as any).failure.status, 409);
assert.ok((v({ levels: ["due_diligence"], allow: ["dd"] }, { isLedger: true }) as any).ok);
// Check first.
const flagged = v({ levels: ["due_diligence"] }, { unchecked: ["scanned", "hidden_words"] }) as any;
assert.deepEqual(flagged.failure.body.flags, ["scanned", "hidden_words"]);
assert.equal(flagged.failure.body.code, "check_first");
assert.equal((v({ levels: ["due_diligence"] }, { unchecked: ["scanned", "hidden_words"], checkedFlags: ["scanned"] }) as any).failure.body.flags.length, 1);
const ticked = v({ levels: ["due_diligence"] }, { unchecked: ["scanned"], checkedFlags: ["scanned"] }) as any;
assert.ok(ticked.ok);
assert.deepEqual(ticked.tick, ["scanned"]);
assert.ok((v({ deny: ["dd"] }, { unchecked: ["scanned"] }) as any).ok, "hiding needs no tick (it grants nothing)");
assert.equal(parseShareBody({ levels: "x" }), null);
assert.equal(parseShareBody({ allow: new Array(501).fill("a") }), null);

// ── shareSummary chips ──
const L = (accessLevel: string) => ({ audience: "level", accessLevel, buyerEmail: null, effect: "allow" });
const B = (buyerEmail: string, effect = "allow") => ({ audience: "buyer", accessLevel: null, buyerEmail, effect });
assert.equal(shareSummary([]).label, "Not shared");
assert.equal(shareSummary([L("due_diligence")]).label, "Due diligence buyers");
assert.equal(shareSummary([L("due_diligence"), B("a"), B("b")]).label, "Due diligence + 2 buyers");
assert.equal(shareSummary([B("a"), B("b"), B("c")]).label, "3 buyers");
assert.equal(shareSummary([L("due_diligence"), L("loi")]).label, "Every buyer with the room");
assert.equal(shareSummary([L("due_diligence"), B("a", "deny")]).label, "Due diligence buyers (hidden from 1)");
assert.equal(shareSummary([B("a", "deny")]).shared, false);

// ── HTTP: bulk, folder, plan, share-like-replaced ──
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
for (const n of ["t2.pdf", "fs.pdf", "pay.pdf", "gl.xlsx", "lease.pdf"]) fs.writeFileSync(path.join(root, "docs", n), "x");
const docs = [
  { id: "t2", dealId: "D", name: "T2 corporate income tax return 2023", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "fs", dealId: "D", name: "Financial statements FY2023", originalName: "FS.pdf", category: "financials", fileUrl: "/uploads/docs/fs.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "pay", dealId: "D", name: "Payroll register 2024", originalName: "pay.pdf", category: "financials", fileUrl: "/uploads/docs/pay.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "gl", dealId: "D", name: "General ledger FY2024", originalName: "GL export.xlsx", category: "financials", subcategory: "general_ledger", fileUrl: "/uploads/docs/gl.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdAt: now },
  { id: "lease", dealId: "D", name: "Warehouse lease", originalName: "lease.pdf", category: "legal", fileUrl: "/uploads/docs/lease.pdf", mimeType: "application/pdf", createdAt: now },
];
const h = await vdrTestApp({ root, docs, deals: [{ id: "D", brokerId: "b1", businessName: "Test Co", isLive: true, extractedInfo: {} }], access, now });
const R = "/api/deals/D/data-room";
assert.equal((await h.call("POST", `${R}/setup`, { mode: "auto" }, "b1")).status, 200);
const itemOf = (doc: string) => h.f.items.find((i) => i.documentId === doc && !i.removedAt)!;
const ready = (doc: string, extra: any = {}) => { itemOf(doc).prepared = { status: "ready", kind: "pdf", forFile: "aaaaaaaaaaaaaaaa", pages: [{ w: 1, h: 1, hasText: true }], ...extra }; };
ready("t2"); ready("fs"); ready("lease");
ready("pay", { personalRecords: true });
itemOf("gl").prepared = { status: "ready", kind: "ledger_pending", forFile: "bbbbbbbbbbbbbbbb", personalRecords: true };
const tax = h.f.folders.find((x) => x.presetKey === "financial.tax")!;

// Plan: statements + tax → DD; the payroll (staff records) and the ledger are "check first" / never in the plan.
const plan = await h.call("GET", `${R}/plan`, undefined, "b1");
assert.equal(plan.status, 200);
const planFolders = plan.json.folders.map((x: any) => [x.name, x.recommended, x.levels]);
assert.ok(planFolders.some((x: any) => x[0] === "Tax returns" && x[1] === "dd" && x[2][0] === "due_diligence"));
assert.ok(plan.json.flagged.some((x: any) => x.itemId === itemOf("pay").id), "staff records → check these yourself first");
const ledgerFolder = h.f.folders.find((x) => x.presetKey === "financial.gl")!;
const choice = plan.json.folders.map((x: any) => ({ folderId: x.folderId, levels: x.levels }));
// The broker sets the ledger folder to DD too, but doesn't tick the flagged documents.
const glChoice = choice.find((c: any) => c.folderId === ledgerFolder.id);
if (glChoice) glChoice.levels = ["due_diligence"];
const applied = await h.call("POST", `${R}/plan`, { folders: choice, includeFlagged: [], acceptSummaries: [] }, "b1");
assert.equal(applied.status, 200);
const levelsOf = (doc: string) => h.f.shares.filter((s) => s.itemId === itemOf(doc).id).map((s) => s.accessLevel).sort();
assert.deepEqual(levelsOf("t2"), ["due_diligence"]);
assert.deepEqual(levelsOf("fs"), ["due_diligence"]);
assert.deepEqual(levelsOf("pay"), [], "flagged and not ticked → not shared");
assert.deepEqual(levelsOf("gl"), [], "a ledger is flagged (staff/pay) → never shared unticked");
assert.deepEqual(h.f.folders.find((x) => x.id === tax.id)!.shareHint, { levels: ["due_diligence"] }, "the choice kept as a hint");
assert.ok(h.f.rooms.get("D").planAppliedAt, "plan applied");
assert.equal(applied.json.newlyVisibleBuyers, 1, "Northgate (due diligence) can now open them");
// Ticking the payroll (in 4.1 Staff, which the broker now sets to due diligence) includes it.
const payFolder = itemOf("pay").folderId;
assert.equal(h.f.folders.find((x) => x.id === payFolder)!.presetKey, "people.staff");
await h.call("POST", `${R}/plan`, { folders: [{ folderId: payFolder, levels: ["due_diligence"] }, ...choice.filter((c: any) => c.folderId !== payFolder)], includeFlagged: [itemOf("pay").id] }, "b1");
assert.deepEqual(levelsOf("pay"), ["due_diligence"], "ticked → shared, with the tick stored");
assert.deepEqual(itemOf("pay").checkedFlags, ["staff_records"]);

// PUT on a flagged document without the tick → 409 check_first; with it → saved + tick stored.
const bare = await h.call("PUT", `${R}/items/${itemOf("gl").id}/shares`, { levels: ["due_diligence"], allow: [], deny: [] }, "b1");
assert.equal(bare.status, 409);
assert.equal(bare.json.code, "check_first");
const glToFull = await h.call("PUT", `${R}/items/${itemOf("gl").id}/shares`, { levels: ["named"], allow: [], deny: [], checkedFlags: ["staff_records"] }, "b1");
assert.equal(glToFull.status, 409);
assert.equal(glToFull.json.error, LEDGER_DD_ONLY);

// Bulk: add Full CIM to three; the ledger is skipped for Full CIM with gl's words, the flagged one needs its tick.
const fullTarget = [itemOf("lease").id, itemOf("gl").id, itemOf("t2").id];
const bulk = await h.call("POST", `${R}/shares/bulk`, { itemIds: fullTarget, add: { levels: ["named"], allow: [] } }, "b1");
assert.equal(bulk.status, 200);
assert.deepEqual(levelsOf("lease"), ["due_diligence", "named"], "the plan gave leases to due diligence; Full CIM added");
assert.deepEqual(levelsOf("t2"), ["due_diligence", "named"]);
assert.ok(bulk.json.skipped.some((s: any) => s.itemId === itemOf("gl").id && s.reason === LEDGER_DD_ONLY));
// Folder share: everything in 1.2 Tax returns gets "hidden from Sam" kept, plus Sam by name? (by name: not on a hidden one.)
const folder = await h.call("POST", `${R}/shares/bulk`, { folderId: tax.id, add: { allow: ["named"] } }, "b1");
assert.equal(folder.status, 200);
assert.ok(h.f.shares.some((s) => s.itemId === itemOf("t2").id && s.audience === "buyer" && s.buyerEmail === "sam@f.invalid"));
// Remove levels in bulk (Stop sharing).
await h.call("POST", `${R}/shares/bulk`, { itemIds: [itemOf("lease").id], remove: { levels: ["due_diligence", "named"] } }, "b1");
assert.deepEqual(levelsOf("lease"), []);
assert.ok(h.f.activity.some((a) => a.action === "shared") && h.f.activity.some((a) => a.action === "unshared"), "the diff is logged");

// Share with the same people (V8): the seller's new version takes the old one's place, unshared; one click copies the grants.
h.f.documents.push({ id: "t2b", dealId: "D", name: "T2 corporate income tax return 2023 (corrected)", originalName: "T2b.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now, uploadedBy: "seller", sourceKind: "document", visibility: "shared", subcategory: null });
const next = await markReplacement("t2", "t2b", h.setupDeps);
assert.ok(next);
assert.equal(h.f.shares.filter((s) => s.itemId === next!.id).length, 0, "the new version is not shared");
const room = await h.call("GET", R, undefined, "b1");
const row = room.json.items.find((i: any) => i.id === next!.id);
assert.deepEqual(row.newVersion, { replaces: itemOf("t2").id, oldWasShared: true });
assert.equal((await h.call("POST", `${R}/items/${next!.id}/share-like-replaced`, {}, "b1")).status, 200);
assert.deepEqual(h.f.shares.filter((s) => s.itemId === next!.id).map((s) => s.accessLevel ?? s.buyerEmail).sort(), ["due_diligence", "named", "sam@f.invalid"].sort());
assert.equal((await shareLikeReplaced(itemOf("lease").id, "b1", h.setupDeps)).copied, 0, "not a new version → nothing copied");

h.close();
console.log("vdr-shares: all passed");
process.exit(0);
