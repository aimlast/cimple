/**
 * gl wired into the other streams at the gl merge (release/oct merge step 7;
 * INTEGRATION §2.1, §2.2, §2.6, §2.8, §2.17, C4, C18, C19):
 *   - gl reads access levels through teaser's registry (server/gl/levels.ts
 *     IS the registry) and buyerCimExtras gives a Teaser link nothing;
 *   - servedCimFor passes the buyer's link to buyerCimExtras;
 *   - the data room's gl adapter is gl's own exports (isGlDocument,
 *     ledgerStatusForVdr, ledgerSummaryForVdr, withHeavySheetSlot — C18/C19),
 *     and its rows route asks gl only for a READY ledger item, maps gl's 404
 *     to null, never passes a buyer's search words into the room's log;
 *   - the wiring module: gl's ledger events re-prepare the room's items,
 *     and the room's per-buyer deny rows reach gl's DD page;
 *   - the view room: VdrViewer shows gl's ledger viewer to a DD buyer, gl's
 *     links on the CIM paper go through the room (GlRoomLinkProvider, inside
 *     VdrLinkProvider);
 *   - hook order on documents (gl before the data room, §2.17), the CIM
 *     tab's Versions slot carries gl's hold notice, the routing lines are in
 *     §1.2 order, the generic upload files a GL-row upload as a ledger.
 * No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/gl/gl-merge-wiring.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import * as registry from "../../shared/access-levels";
import * as glLevels from "../../server/gl/levels";
import { buyerCimExtras } from "../../server/cim/buyer-extras";
import * as adapter from "../../server/vdr/gl-adapter";
import { isGlDocument as glIsGlDocument } from "../../server/gl/audience";
import { withHeavySheetSlot } from "../../server/documents/heavy-sheet";
import { ledgerDenyLookup } from "../../server/routes/gl-data-room-wiring";
import { glDocRef } from "../../client/src/components/vdr/GlRoomLinks";
import { NOTIFICATION_ROUTING } from "../../shared/schema";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

await test("gl reads levels through teaser's registry (C4): levels.ts is the registry itself", () => {
  assert.equal(glLevels.isTeaserOnly, registry.isTeaserOnly);
  assert.equal(glLevels.cimModeForAccessLevel, registry.cimModeForAccessLevel);
  // The answers gl's interim mirror pinned, legacy values included.
  for (const [v, teaserOnly, mode] of [
    ["teaser_only", true, "blind"], ["blind", false, "blind"], ["named", false, "normal"], ["due_diligence", false, "dd"],
    ["teaser", false, "blind"], ["full", false, "blind"], ["loi", false, "normal"], ["", true, "blind"], [null, true, "blind"], ["nonsense", true, "blind"],
  ] as const) {
    assert.equal(glLevels.isTeaserOnly(v), teaserOnly, `isTeaserOnly(${v})`);
    assert.equal(glLevels.cimModeForAccessLevel(v), mode, `mode(${v})`);
  }
  assert.ok(!/MODE_OF|loi:|full:/.test(src("server/gl/levels.ts")), "no private mirror left");
});

await test("buyerCimExtras: a Teaser link gets nothing (seesCim first); servedCimFor passes the buyer's link", async () => {
  for (const level of ["teaser_only", "", null, undefined]) {
    assert.deepEqual(await buyerCimExtras({ id: "D-none" } as any, level as any, "acc-1"), { glEvidence: null, figures: null });
  }
  const extras = src("server/cim/buyer-extras.ts");
  assert.ok(/if \(!seesCim\(accessLevel\)\)/.test(extras) && !/gl\/levels/.test(extras));
  const r = src("server/analytics/renditions.ts");
  assert.ok(r.includes("buyerCimExtras(servedDeal, accessLevel, opts.accessId ?? null)"), "§2.2 final servedCimFor call");
  // The three buyer paths, and only through the helper.
  assert.ok(src("server/routes.ts").includes("buyerCimExtras(servedDeal, access.accessLevel, access.id)"));
  assert.ok(src("server/qa/cim-context.ts").includes("buyerCimExtras(readerDeal as any, reader.accessLevel, reader.id ?? null)"));
});

await test("buildBuyerCim's Teaser early return carries glEvidence, figureLayer and figureLayerDropped as null (§2.2 step 1)", async () => {
  const { buildBuyerCim } = await import("../../shared/cim-buyer-view");
  const cim = buildBuyerCim({ deal: { id: "D", businessName: "X" } as any, accessLevel: "teaser_only", sections: [], overrides: [], glEvidence: { mode: "dd" } as any });
  assert.deepEqual(cim, { mode: "blind", sections: [], preparing: false, heldBack: 0, leaked: [], leakReasons: {}, glEvidence: null, figureLayer: null, figureLayerDropped: null });
});

await test("the data room's gl adapter is gl's own exports (C18, C19)", () => {
  assert.equal(adapter.isGlDocument, glIsGlDocument);
  assert.equal(adapter.withHeavySheetSlot, withHeavySheetSlot);
  const a = src("server/vdr/gl-adapter.ts");
  assert.ok(!/Not merged yet|_documentId: string|_doc: \{/.test(a), "no placeholder bodies left");
  // vdr's prepare queue runs every sheet job inside gl's slot (C19).
  const prep = src("server/vdr/prepare.ts");
  assert.ok(prep.includes("sheetSlot: withHeavySheetSlot") && prep.includes('fileKind === "sheet" ? await deps.sheetSlot(run)'));
});

await test("the rows query is parsed strictly (strings and whole numbers only)", () => {
  assert.deepEqual(adapter.ledgerQueryFrom({ fy: "2024", account: " acc ", q: "Lexus", page: "2", around: "31" }), { fy: "2024", account: "acc", q: "Lexus", page: 2, around: 31 });
  assert.deepEqual(adapter.ledgerQueryFrom({ fy: ["2024"], page: "-1", around: "1e9", q: "" } as any), { fy: null, account: null, q: null, page: 0, around: null });
});

// A ledger read into gl's memory store (no database), opened through the room's adapter.
const B = brightwater();
const doc = await B.readLedger("qbo-classic.csv");
const logs: Array<Record<string, unknown> | undefined> = [];
const ctxFor = (over: Record<string, any> = {}) => ({
  access: { id: "acc-dd" },
  deal: { id: B.deal.id },
  item: { id: "item-1", documentId: doc.id, prepared: { status: "ready", kind: "ledger", forFile: "x" } },
  mode: "dd",
  viewer: { kind: "buyer", teamMemberId: null, name: null, email: "dd@example.invalid" },
  watermark: { name: null, email: "dd@example.invalid", trace: "ABC123", at: "" },
  preview: false,
  logView: (d?: Record<string, unknown>) => { logs.push(d); },
  ...over,
}) as any;

await test("ledger rows for a DD buyer go through gl (masked, 100 a page) and are logged without the search words", async () => {
  const st = await adapter.ledgerStatusForVdr(doc.id);
  assert.equal(st?.status, "ready");
  assert.match(await adapter.ledgerSummaryForVdr(doc.id), /^General ledger.*entries.*accounts\.$/);
  const rows = await adapter.ledgerRowsForBuyer(ctxFor(), doc.id, { page: "0" });
  assert.ok(rows && rows.total === 2117 && rows.rows.length === 100);
  const searched = await adapter.ledgerRowsForBuyer(ctxFor(), doc.id, { q: "Lexus" });
  assert.ok(searched && searched.total > 0);
  assert.ok(logs.length >= 2 && logs.every((l) => l?.ledger === true));
  assert.ok(!JSON.stringify(logs).includes("Lexus"), "the buyer's search words never reach the room's log");
  assert.equal(logs.at(-1)?.searched, true);
});

await test("anything but a ready ledger item of that document → null (the route answers 404), gl's own locks hold", async () => {
  assert.equal(await adapter.ledgerRowsForBuyer(ctxFor({ item: { id: "i", documentId: doc.id, prepared: { status: "ready", kind: "pdf" } } }), doc.id, {}), null, "a tax return, not a ledger");
  assert.equal(await adapter.ledgerRowsForBuyer(ctxFor({ item: { id: "i", documentId: doc.id, prepared: { status: "ready", kind: "ledger_pending" } } }), doc.id, {}), null, "not read yet");
  assert.equal(await adapter.ledgerRowsForBuyer(ctxFor({ item: { id: "i", documentId: "other-doc", prepared: { status: "ready", kind: "ledger" } } }), doc.id, {}), null, "another document's item");
  assert.equal(await adapter.ledgerRowsForBuyer(ctxFor({ mode: "normal" }), doc.id, {}), null, "a Full-CIM buyer (gl's own lock)");
  assert.equal(await adapter.ledgerRowsForBuyer(ctxFor({ deal: { id: "another-deal" } }), doc.id, {}), null, "another deal (gl's own lock)");
  B.w.documents.get(doc.id)!.visibility = "broker_only";
  assert.equal(await adapter.ledgerRowsForBuyer(ctxFor(), doc.id, {}), null, "private to the broker");
  B.w.documents.get(doc.id)!.visibility = "shared";
});

await test("the room's per-buyer deny reaches gl: only live items with a deny row for THIS buyer's email", async () => {
  const lookup = ledgerDenyLookup({
    getAccess: async (id) => (id === "acc-1" ? { dealId: "D", buyerEmail: " Tom@Example.invalid " } : id === "acc-x" ? { dealId: "OTHER", buyerEmail: "tom@example.invalid" } : undefined),
    listItems: async () => [
      { id: "i-gl", documentId: "doc-gl", removedAt: null },
      { id: "i-adj", documentId: "doc-adj", removedAt: null },
      { id: "i-gone", documentId: "doc-gone", removedAt: new Date() },
      { id: "i-tomb", documentId: null, removedAt: null },
    ],
    listShares: async () => [
      { itemId: "i-gl", audience: "buyer", buyerEmail: "tom@example.invalid", effect: "deny" },
      { itemId: "i-adj", audience: "buyer", buyerEmail: "someone@else.invalid", effect: "deny" },
      { itemId: "i-adj", audience: "buyer", buyerEmail: "tom@example.invalid", effect: "allow" },
      { itemId: "i-gone", audience: "buyer", buyerEmail: "tom@example.invalid", effect: "deny" },
      { itemId: "i-tomb", audience: "buyer", buyerEmail: "tom@example.invalid", effect: "deny" },
      { itemId: "i-adj", audience: "level", buyerEmail: null, effect: "deny" },
    ],
  });
  assert.deepEqual([...(await lookup("D", "acc-1"))], ["doc-gl"]);
  assert.equal((await lookup("D", "acc-x")).size, 0, "a link of another deal");
  assert.equal((await lookup("D", "nope")).size, 0);
  const w = src("server/routes/gl-data-room-wiring.ts");
  assert.ok(w.includes("onGlLedgerStatusChanged((documentId) => onLedgerStatusChanged(documentId))") && w.includes("setGlLedgerDenyLookup("));
  const routes = src("server/routes.ts");
  assert.ok(routes.indexOf("registerGlRoutes(app);") < routes.indexOf("await registerGlDataRoomWiring();"), "wired once, right after gl's routes");
});

await test("the view room: a DD buyer reads a ready ledger in gl's viewer; gl's links go through the room", () => {
  const viewer = src("client/src/components/vdr/VdrViewer.tsx");
  assert.ok(viewer.includes("<GlLedgerViewer") && viewer.includes("/data-room/ledger/") && viewer.includes("manifest.ledgerDocumentId"));
  assert.ok(src("server/vdr/serve.ts").includes('p.kind === "ledger" && doc ? { ledgerDocumentId: doc.id }'));
  const room = src("client/src/pages/BuyerViewRoom.tsx");
  const vdr = room.indexOf("<VdrLinkProvider"), gl = room.indexOf("<GlRoomLinkProvider>"), main = room.indexOf('<main className="flex-1 min-w-0">');
  assert.ok(vdr > 0 && vdr < gl && gl < main, "VdrLinkProvider → GlRoomLinkProvider → the CIM (§2.4)");
  // gl's neutral labels pick the chip's kind and year; the chip never carries them as a title.
  assert.deepEqual(glDocRef("d1", "T4 2024"), { documentId: "d1", kind: "payroll_report", period: "2024" });
  assert.deepEqual(glDocRef("d2", "Invoice or letter (2024)"), { documentId: "d2", kind: "invoice", period: "2024" });
  assert.deepEqual(glDocRef("d3", "Financial statements 2023"), { documentId: "d3", kind: "financial_statements", period: "2023" });
  assert.deepEqual(glDocRef("d4", "Supporting document (2022)"), { documentId: "d4", kind: "other", period: "2022" });
  assert.ok(!/title=/.test(src("client/src/components/vdr/GlRoomLinks.tsx").replace(/title: res\.title/g, "")), "no title prop on a chip");
  assert.ok(src("client/src/components/vdr/GlRoomLinks.tsx").includes('links.source.kind === "broker") return <VdrCitationChip'), "a broker preview gets the room's broker chip, never the buyer's ask words");
});

await test("documents: gl runs before the data room at every hook (§2.17)", () => {
  const ingest = src("server/documents/ingest.ts");
  assert.ok(ingest.indexOf("isTogetherSitting(doc)) return") < ingest.indexOf("ingestLedgerFromDocument(doc)"), "together, then gl");
  assert.ok(ingest.indexOf("ingestLedgerFromDocument(doc)") < ingest.indexOf("const storedOnly ="), "gl, then the room's short-circuit");
  assert.ok(ingest.indexOf("onGlSupportDocumentRead") < ingest.indexOf("autoFileIfRoom(doc.id)"), "finally: gl doc-check, then auto-file");
  const cleanup = src("server/documents/cleanup.ts");
  assert.ok(cleanup.indexOf("onTogetherSourceDeleted(doc)") < cleanup.indexOf("onLedgerDocumentDeleted(doc)"));
  assert.ok(cleanup.indexOf("onLedgerDocumentDeleted(doc)") < cleanup.indexOf("await onSourceDeleted(doc)"), "gl, then the tombstone");
  const vis = src("server/documents/source-visibility.ts");
  assert.ok(vis.indexOf("onGlSourceAudienceChanged(documentId)") < vis.indexOf("onSourceVisibilityChanged(documentId"), "gl, then the room");
});

await test("seams: routing lines in §1.2 order, Versions-card slot, the GL-row upload in the shared upload body", () => {
  const keys = Object.keys(NOTIFICATION_ROUTING);
  assert.deepEqual(keys.slice(-3), ["seller_gl_request", "gl_needs_broker", "seller_document_request"]);
  const slots = src("client/src/pages/broker/deal/cim-tab-slots.tsx");
  assert.ok(/key: "gl", useExtras: \(dealId\) => \(\{ dd: <GlGenerationNotice/.test(slots));
  const tab = src("client/src/pages/broker/deal/CimTab.tsx");
  assert.ok(tab.includes("action={ddHeld ? undefined : {") && !tab.includes("<GlGenerationNotice"), "the notice comes through the slot; the DD action hides while held");
  const up = src("server/documents/upload.ts");
  assert.ok(up.includes('subcategory: forGlRow ? "general_ledger"') && up.includes("canTraceAddbacks") && up.includes("sellerToken"));
  assert.ok(src("server/routes.ts").includes("sellerToken: viaSellerToken ?"));
  const docs = src("client/src/pages/seller/SellerDocuments.tsx");
  assert.ok(docs.includes("<SellerGlRow") && docs.includes("chips={<SellerRoomChips"), "the room's chips on the GL row too");
});

cleanup(B.w);
done("gl-merge-wiring");
