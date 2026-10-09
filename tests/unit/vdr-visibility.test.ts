/**
 * vdr spec §4.1–4.3: who has a room, what a reader may see, what downloads.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-visibility.test.ts
 */
import assert from "node:assert/strict";
import {
  dataRoomLevelRule,
  hasRoomAccess,
  isRoomLevel,
  itemVisibility,
  listedForReader,
  downloadDecision,
  downloadCopy,
  isRoomMaterial,
  citableDocument,
  isLedgerDoc,
  itemFlags,
  uncheckedLookFlags,
  pageListCopy,
  citationLabel,
  cleanPeriod,
  vdrBuyerHref,
  vdrBrokerHref,
  DATA_ROOM_LEVELS,
  type VdrPrepared,
  type VisibilityInput,
} from "../../shared/vdr";

// ── Room access by level (registry only; legacy keys read as the new ones) ──
assert.equal(dataRoomLevelRule("teaser_only"), "never_teaser");
assert.equal(dataRoomLevelRule(null), "never_teaser", "unknown → least access");
assert.equal(dataRoomLevelRule("blind"), "never_blind");
assert.equal(dataRoomLevelRule("teaser"), "never_blind", "legacy teaser = Blind CIM link (C3)");
assert.equal(dataRoomLevelRule("full"), "never_blind", "legacy full = Blind CIM");
assert.equal(dataRoomLevelRule("named"), "manual");
assert.equal(dataRoomLevelRule("loi"), "manual", "legacy loi = Full CIM");
assert.equal(dataRoomLevelRule("due_diligence"), "auto_on");
assert.deepEqual([...DATA_ROOM_LEVELS], ["due_diligence", "named"]);
assert.equal(isRoomLevel("named"), true);
assert.equal(isRoomLevel("blind"), false);

for (const [level, setting, expected] of [
  ["due_diligence", "auto", true], ["due_diligence", null, true], ["due_diligence", "off", false], ["due_diligence", "on", true],
  ["named", "auto", false], ["named", "on", true], ["named", "off", false], ["loi", "on", true],
  ["blind", "on", false], ["full", "on", false], ["teaser", "on", false], ["teaser_only", "on", false],
] as const) {
  assert.equal(hasRoomAccess(level, setting), expected, `${level}/${setting}`);
}

// ── Room material (V1) ──
const doc = (o: Partial<{ visibility: string | null; sourceKind: string | null; category: string | null; subcategory: string | null; fileUrl: string | null; dealId: string }> = {}) => ({
  dealId: "D", visibility: "shared", sourceKind: "document", category: "financials", subcategory: null, fileUrl: "/uploads/docs/doc_a.pdf", ...o,
});
assert.equal(isRoomMaterial(doc()), true);
assert.equal(isRoomMaterial(doc({ sourceKind: null })), true, "legacy rows without a kind are documents");
for (const k of ["email", "call", "video_call", "crm", "website", "social", "broker", "system"]) assert.equal(isRoomMaterial(doc({ sourceKind: k })), false, k);
assert.equal(isRoomMaterial(doc({ visibility: "broker_only" })), false);
assert.equal(isRoomMaterial(doc({ fileUrl: null })), false);
assert.equal(isRoomMaterial(doc({ sourceKind: null, category: "transcripts" })), false, "legacy transcript");
assert.equal(isRoomMaterial(doc({ sourceKind: null, category: "email" })), false, "legacy email");
for (const sub of ["transcript", "call", "email", "crm_note"]) assert.equal(isRoomMaterial(doc({ sourceKind: null, subcategory: sub })), false, sub);
assert.equal(citableDocument(doc({ visibility: "broker_only" })), false);

// ── Ledgers ──
assert.equal(isLedgerDoc({ subcategory: "general_ledger", name: "anything.pdf" }), true);
assert.equal(isLedgerDoc({ name: "General ledger 2024", originalName: "GL.xlsx", mimeType: null }), true);
assert.equal(isLedgerDoc({ name: "General ledger 2024 (printout)", originalName: "gl.pdf", mimeType: "application/pdf" }), false, "a PDF ledger stays a normal document");
assert.equal(isLedgerDoc({ name: "Trial balance FY24", originalName: "tb.csv" }), true);
assert.equal(isLedgerDoc({ subcategory: "addback_support", name: "General ledger extract", originalName: "x.xlsx" }), false, "add-back support is never a ledger");

// ── itemVisibility ──
const ready: VdrPrepared = { status: "ready", forFile: "0123456789abcdef", kind: "pdf", pages: [{ w: 612, h: 792, hasText: true }] };
function input(o: {
  level?: string; email?: string; mode?: "normal" | "dd";
  removed?: boolean; prepared?: VdrPrepared | null; ledger?: boolean;
  d?: ReturnType<typeof doc> | null; fileExists?: boolean;
  shares?: VisibilityInput["shares"]; readerDeal?: string; itemDeal?: string;
} = {}): VisibilityInput {
  return {
    dealId: "D",
    reader: { dealId: o.readerDeal ?? "D", accessLevel: o.level ?? "due_diligence", buyerEmail: o.email ?? "Jane@Northgate.invalid", mode: o.mode ?? "dd" },
    item: { dealId: o.itemDeal ?? "D", removedAt: o.removed ? new Date() : null, prepared: o.prepared === undefined ? ready : o.prepared, isLedger: !!o.ledger },
    doc: o.d === undefined ? doc() : o.d,
    servedFileExists: o.fileExists ?? true,
    shares: o.shares ?? [{ audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow" }],
  };
}
const reason = (v: ReturnType<typeof itemVisibility>) => (v.visible ? "visible" : v.reason);

assert.equal(reason(itemVisibility(input())), "visible");
assert.equal(reason(itemVisibility(input({ itemDeal: "OTHER" }))), "removed", "another deal's item");
assert.equal(reason(itemVisibility(input({ readerDeal: "OTHER" }))), "removed", "another deal's reader");
assert.equal(reason(itemVisibility(input({ d: doc({ dealId: "OTHER" }) }))), "removed", "another deal's document");
assert.equal(reason(itemVisibility(input({ removed: true }))), "removed");
assert.equal(reason(itemVisibility(input({ d: null }))), "removed");
assert.equal(reason(itemVisibility(input({ d: doc({ visibility: "broker_only" }) }))), "private");
assert.equal(reason(itemVisibility(input({ d: doc({ sourceKind: "email" }) }))), "not_room_material");
assert.equal(reason(itemVisibility(input({ d: doc({ sourceKind: null, category: "transcripts" }) }))), "not_room_material");
assert.equal(reason(itemVisibility(input({ fileExists: false }))), "file_missing");
// Shares by level (legacy level values on either side match) and by buyer email (case-insensitive)
assert.equal(reason(itemVisibility(input({ level: "named", mode: "normal" }))), "not_shared", "a DD share isn't a Full CIM share");
assert.equal(reason(itemVisibility(input({ level: "loi", mode: "normal", shares: [{ audience: "level", accessLevel: "named", buyerEmail: null, effect: "allow" }] }))), "visible", "legacy loi reader + named share");
assert.equal(reason(itemVisibility(input({ level: "named", mode: "normal", shares: [{ audience: "level", accessLevel: "loi", buyerEmail: null, effect: "allow" }] }))), "visible", "legacy loi share row");
assert.equal(reason(itemVisibility(input({ shares: [] }))), "not_shared");
assert.equal(reason(itemVisibility(input({ level: "named", mode: "normal", shares: [{ audience: "buyer", accessLevel: null, buyerEmail: "jane@northgate.invalid", effect: "allow" }] }))), "visible", "per-buyer allow by email");
assert.equal(reason(itemVisibility(input({ shares: [
  { audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow" },
  { audience: "buyer", accessLevel: null, buyerEmail: " JANE@northgate.invalid ", effect: "deny" },
] }))), "excluded", "a deny beats the level share");
assert.equal(reason(itemVisibility(input({ shares: [{ audience: "buyer", accessLevel: null, buyerEmail: "jane@northgate.invalid", effect: "deny" }] }))), "excluded", "deny without allow");
assert.equal(reason(itemVisibility(input({ shares: [{ audience: "buyer", accessLevel: null, buyerEmail: "someone@else.invalid", effect: "allow" }] }))), "not_shared");
// Ledgers: DD only, pending until gl reads them
assert.equal(reason(itemVisibility(input({ ledger: true, prepared: { ...ready, kind: "ledger" } }))), "visible");
assert.equal(reason(itemVisibility(input({ ledger: true, level: "named", mode: "normal", prepared: { ...ready, kind: "ledger" }, shares: [{ audience: "buyer", accessLevel: null, buyerEmail: "jane@northgate.invalid", effect: "allow" }] }))), "dd_only");
assert.equal(reason(itemVisibility(input({ ledger: true, prepared: { ...ready, kind: "ledger_pending" } }))), "ledger_pending");
// Not ready yet → listed ("Getting it ready…") but not openable
assert.equal(reason(itemVisibility(input({ prepared: null }))), "not_ready");
assert.equal(reason(itemVisibility(input({ prepared: { ...ready, status: "pending" } }))), "not_ready");
assert.equal(reason(itemVisibility(input({ prepared: { ...ready, status: "failed", errorCode: "password" } }))), "not_ready");
// Only visible and not-ready items are ever listed; everything else is absent from list, search and resolve.
assert.equal(listedForReader(itemVisibility(input())), true);
assert.equal(listedForReader(itemVisibility(input({ prepared: null }))), true);
for (const v of [input({ shares: [] }), input({ ledger: true, prepared: { ...ready, kind: "ledger_pending" } }), input({ d: doc({ visibility: "broker_only" }) }), input({ removed: true })]) {
  assert.equal(listedForReader(itemVisibility(v)), false);
}

// ── Downloads (§4.3) ──
const dd = (kind: VdrPrepared["kind"], o: Partial<VdrPrepared> = {}, item = { downloadable: true, downloadOriginal: false }, buyer = { allowDownloads: true }, ledger: { allowOriginalDownload: boolean } | null = null) =>
  downloadDecision({ item, prepared: { ...ready, kind, ...o }, buyer, ledger });
assert.deepEqual(dd("pdf"), { allowed: true, as: "pages_pdf" });
assert.deepEqual(dd("image"), { allowed: true, as: "pages_pdf" });
assert.deepEqual(dd("sheet"), { allowed: true, as: "values_xlsx" });
assert.deepEqual(dd("html"), { allowed: false, why: "not_allowed" }, "Word is view-only by default");
assert.deepEqual(dd("text"), { allowed: false, why: "not_allowed" });
assert.deepEqual(dd("pdf", {}, { downloadable: false, downloadOriginal: false }), { allowed: false, why: "not_allowed" }, "the document must allow it");
assert.deepEqual(dd("pdf", {}, undefined, { allowDownloads: false }), { allowed: false, why: "not_allowed" }, "and the buyer");
assert.deepEqual(dd("pdf", {}, { downloadable: true, downloadOriginal: true }), { allowed: true, as: "original_sanitised_pdf" });
assert.deepEqual(dd("pdf", { personal: { count: 1, kinds: ["sin"], pages: [2] } }, { downloadable: true, downloadOriginal: true }), { allowed: false, why: "personal_numbers" });
assert.deepEqual(dd("pdf", { servedCopy: "original" }, { downloadable: true, downloadOriginal: true }), { allowed: true, as: "pages_pdf" }, "an unsanitised PDF only ever downloads as page images");
assert.deepEqual(dd("sheet", { officeScan: { count: 0, parts: [] } }, { downloadable: true, downloadOriginal: true }), { allowed: true, as: "original_stamped_office" });
assert.deepEqual(dd("sheet", { officeScan: { count: 2, parts: ["xl/comments1.xml"] } }, { downloadable: true, downloadOriginal: true }), { allowed: false, why: "personal_numbers" });
assert.deepEqual(dd("sheet", { officeScan: { count: 0, parts: [] }, personal: { count: 3, kinds: ["sin"], pages: [] } }, { downloadable: true, downloadOriginal: true }), { allowed: false, why: "personal_numbers" }, "the SIN column counts");
assert.deepEqual(dd("html", { officeScan: { count: 0, parts: [] } }, { downloadable: true, downloadOriginal: true }), { allowed: true, as: "original_stamped_office" });
assert.deepEqual(dd("html", { officeScan: { count: 1, parts: ["word/header1.xml"] } }, { downloadable: true, downloadOriginal: true }), { allowed: false, why: "personal_numbers" });
assert.deepEqual(dd("ledger"), { allowed: false, why: "ledger" });
assert.deepEqual(dd("ledger", {}, undefined, undefined, { allowOriginalDownload: true }), { allowed: true, as: "ledger_original" });
assert.deepEqual(dd("ledger_pending"), { allowed: false, why: "ledger" });
assert.deepEqual(downloadDecision({ item: { downloadable: true, downloadOriginal: false }, prepared: { ...ready, status: "pending" }, buyer: { allowDownloads: true } }), { allowed: false, why: "not_ready" });
assert.equal(downloadCopy(dd("pdf")), "Download (pages as PDF)");
assert.equal(downloadCopy(dd("html")), "View only. Ask your broker if you need a copy.");
assert.equal(downloadCopy(dd("ledger")), "The general ledger can't be downloaded. Your broker can share specific entries.");

// ── Flags (§4.9) ──
{
  const prepared: VdrPrepared = {
    ...ready,
    pages: [{ w: 1, h: 1, hasText: true }, { w: 1, h: 1, hasText: true }, { w: 1, h: 1, hasText: false }, { w: 1, h: 1, hasText: false }, { w: 1, h: 1, hasText: false }],
    personal: { count: 3, kinds: ["sin"], pages: [2] },
    hidden: { count: 1, pages: [4] },
    forms: { fields: 2, covered: 1 },
    strippedAnnotations: 1,
    personalRecords: true,
  };
  const flags = itemFlags(prepared, { extractedData: { _privateNotes: "Shareholders: …", redFlags: [] } }, { privateMatters: ["a driver's possible departure"] });
  const byKey = Object.fromEntries(flags.map((f) => [f.key, f]));
  assert.equal(byKey.scanned.copy, "Cimple couldn't read text on pages 3–5, so it couldn't check them for personal numbers.");
  assert.equal(byKey.staff_records.look, true);
  assert.match(byKey.hidden_words.copy, /^Words are hidden on page 4, under black boxes or printed so they can't be seen\./);
  assert.equal(byKey.private_matters.copy, "Cimple kept something from this document out of the CIM: 'a driver's possible departure'. Check the document before sharing it.");
  assert.equal(byKey.personal_covered.copy, "3 social insurance numbers on page 2 are covered on every page buyers see.");
  assert.equal(byKey.personal_covered.look, false);
  assert.equal(byKey.form_fields.look, false);
  assert.equal(byKey.comments_removed.look, false);
  assert.equal(byKey.private_notes.look, false);
  // Ticks apply to the CURRENT served file only
  const look = uncheckedLookFlags(flags, { checkedFlags: ["scanned", "staff_records", "hidden_words", "private_matters"], checkedForFile: prepared.forFile }, prepared);
  assert.deepEqual(look, []);
  const stale = uncheckedLookFlags(flags, { checkedFlags: ["scanned", "staff_records", "hidden_words", "private_matters"], checkedForFile: "ffffffffffffffff" }, prepared);
  assert.deepEqual(stale.sort(), ["hidden_words", "private_matters", "scanned", "staff_records"]);
  assert.deepEqual(itemFlags(null, null, { fileMissing: true }).map((f) => f.key), ["file_missing"]);
  assert.deepEqual(itemFlags({ ...ready, kind: "ledger_pending" }, null, { isLedger: true }).map((f) => f.key), ["staff_records"], "a ledger is staff/pay material");
}
assert.equal(pageListCopy([2]), "page 2");
assert.equal(pageListCopy([1, 3, 7]), "pages 1, 3 and 7");

// ── Citations: a fixed vocabulary, never a title ──
assert.equal(citationLabel({ kind: "tax_return", period: "2023" }), "Tax return 2023");
assert.equal(citationLabel({ kind: "financial_statements", period: "FY2024" }), "Financial statements FY2024");
assert.equal(citationLabel({ kind: "bank_statement", period: "2024-06" }), "Bank statement Jun 2024");
assert.equal(citationLabel({ kind: "lease", period: "Harbourline Dental lease" as any }), "Lease", "a non-period is dropped");
assert.equal(citationLabel({ kind: "other", period: "2023" }), "A supporting document");
assert.equal(citationLabel({ kind: "Pacific Coast Logistics" as any, period: null }), "A supporting document", "an unknown kind can't carry text");
assert.equal(cleanPeriod("FY2023"), "FY2023");
assert.equal(cleanPeriod("2023 T2"), null);

// ── Links ──
assert.equal(vdrBuyerHref({ token: "tok", documentId: "doc-1", page: 3 }), "/view/tok/data-room?document=doc-1&page=3");
assert.equal(vdrBuyerHref({ token: "tok", itemId: "it-1", rows: [12, 48], fy: "2024" }), "/view/tok/data-room?doc=it-1&rows=12%2C48&fy=2024");
assert.equal(vdrBrokerHref("deal-1", { itemId: "it-1" }), "/deal/deal-1/data-room?item=it-1");
assert.equal(vdrBrokerHref("deal-1", { view: "todo" }), "/deal/deal-1/data-room?view=todo");

console.log("vdr visibility: ok");
