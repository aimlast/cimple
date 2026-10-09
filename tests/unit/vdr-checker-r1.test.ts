/**
 * The data room's checker round 1 fixes (checks/vdr-r1.md). No AI, no DB.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-checker-r1.test.ts
 *
 *  F2  a question about a spreadsheet or a Word file is never "about page 1"
 *      (stored without a page; a PDF's page is kept when it exists)
 *  F3  key figures read like a person wrote them: "Taxable income (2023)",
 *      no row repeating another's figures, a dollar amount never a "share",
 *      a year's lines one per line
 *  F4  the buyer room says whether the memorandum opens for this link (the
 *      "Memorandum | Data room" switch shows only then)
 *  F5  a long sheet cell wraps inside a capped column; figures stay on one line
 *  F6  the Data room tab's reads start together (one round, not five), and
 *      each file is checked once per load (a tombstone's never)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-r1-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";

const { hasPages, questionPage, shownQuestionPage, figureLines } = await import("../../shared/vdr");
const { factLabel, presentKeyFigures, buyerKeyFigures, documentFacts } = await import("../../server/vdr/analysis");
const { roomAndWaiting, memoFileExists } = await import("../../server/vdr/broker-room");
const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");
const { sheetCellClass } = await import("../../client/src/components/vdr/VdrViewer");

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

// ── F2: pages only for documents with pages ──
assert.equal(hasPages("pdf"), true);
assert.equal(hasPages("image"), true);
for (const k of ["sheet", "html", "text", "ledger", null, undefined] as const) assert.equal(hasPages(k as any), false, String(k));
assert.equal(questionPage("sheet", 0, 1), null, "a sheet's question is never about page 1");
assert.equal(questionPage("html", 0, 1), null);
assert.equal(questionPage("pdf", 3, 2), 2);
assert.equal(questionPage("pdf", 3, 9), null, "a page the document doesn't have");
assert.equal(questionPage("pdf", 3, "x"), null);
assert.equal(questionPage("pdf", 0, 4), 4, "page count not known yet: kept");
assert.equal(shownQuestionPage("sheet", 1), null, "an older row's sheet 'page 1' is never shown");
assert.equal(shownQuestionPage("pdf", 3), 3);
assert.equal(shownQuestionPage(null, 3), 3, "kind not known: shown as stored");
ok("F2: a page only for PDFs and photos (pure rules)");

// ── F3: key figures a reader can take in at a glance ──
assert.equal(factLabel("taxableIncomeByYear"), "Taxable income");
assert.equal(factLabel("netIncomeForTaxPurposesByYear"), "Net income for tax purposes");
assert.equal(factLabel("fy2024StaffT4EarningsByYear"), "FY2024 staff T4 earnings");
assert.equal(factLabel("adjustedEbitdaByYear"), "Adjusted EBITDA");
assert.equal(factLabel("currentPortionLTDByYear"), "Current portion LTD");
assert.equal(factLabel("otherCurrentAssets"), "Other current assets");
assert.equal(factLabel("monthlyRxVolume"), "Monthly Rx volume");

const beaconInfo: any = {
  netIncomeForTaxPurposes: "$464,201 (FY2023)",
  netIncomeForTaxPurposesByYear: { "2023": "$464,201" },
  taxableIncomeByYear: { "2023": "$459,201", "2024": "$569,522" },
  totalAssetsByYear: { "2022": "$1,798,136", "2023": "$1,824,092" },
  cashOnHandByYear: { "2023": "$297,642" },
  cashByYear: { "2023": "$297,642" },
  cashAndDepositsByYear: { "2022": "$309,386", "2023": "$297,642" },
  longTermDebtByYear: { "2022": "$200,000" },
  currentPortionLongTermDebtByYear: { "2023": "$30,000" },
  otherLoanByYear: { "2023": "$30,000" },
  compoundingRevenueShare: "$820,800 (2024)",
  selfPayShare: "11.2% of dispensary revenue",
  shareCapital: "Issued: 100 Class A common shares — $100",
  shareholderLoansByYear: { "2023": "$150,000" },
  bankCharges: "$58,300",
  _fieldSources: {} as Record<string, any>,
};
for (const k of Object.keys(beaconInfo)) {
  if (k.startsWith("_")) continue;
  const v = beaconInfo[k];
  beaconInfo._fieldSources[k] = v && typeof v === "object"
    ? { source: "document", documentId: "t2", years: Object.fromEntries(Object.keys(v).map((y) => [y, { source: "document", documentId: "t2" }])) }
    : { source: "document", documentId: "t2" };
}
const facts = documentFacts(beaconInfo, "t2");
const rows = presentKeyFigures(facts);
const byLabel = new Map(rows.map((r) => [r.label, r]));
const labels = rows.map((r) => r.label);
assert.ok(!labels.some((l) => /by year/i.test(l)), `no "by year" label: ${labels.join(" | ")}`);
// The headline and its by-year map are one row, with the year in the label.
assert.equal(labels.filter((l) => l.startsWith("Net income for tax purposes")).length, 1, labels.join(" | "));
assert.equal(byLabel.get("Net income for tax purposes (2023)")?.text, "$464,201");
assert.deepEqual(byLabel.get("Net income for tax purposes (2023)")!.keys.sort(), ["netIncomeForTaxPurposes", "netIncomeForTaxPurposesByYear"]);
// One year → "(2023)" in the label and the bare figure; several years → newest first.
assert.equal(byLabel.get("Long term debt (2022)")?.text, "$200,000");
assert.equal(byLabel.get("Taxable income")?.text, "2024: $569,522 · 2023: $459,201");
// The same cash figure under three names: the fullest row stays.
assert.equal(labels.filter((l) => /^Cash/.test(l)).join(" | "), "Cash and deposits", labels.join(" | "));
assert.deepEqual(byLabel.get("Cash and deposits")!.keys.sort(), ["cashAndDepositsByYear", "cashByYear", "cashOnHandByYear"]);
// Two different lines that happen to be $30,000 both stay (a round amount alone is not the same fact).
assert.ok(byLabel.has("Current portion long term debt (2023)") && byLabel.has("Other loan (2023)"), labels.join(" | "));
// A dollar amount is never a "share"; a percentage share and "Share capital" keep their names.
assert.equal(byLabel.get("Compounding revenue (2024)")?.text, "$820,800");
assert.ok(!labels.includes("Compounding revenue share") && !labels.some((l) => /revenue share/i.test(l)));
assert.equal(byLabel.get("Self pay share")?.text, "11.2% of dispensary revenue");
assert.ok(byLabel.has("Share capital"), "a real name that starts with 'share' is kept");
assert.ok(byLabel.has("Shareholder loans (2023)"));
ok("F3: labels without 'by year', the year in the label, duplicates folded, no money 'share'");

// The buyer's About panel: the same rows, at most 6, headline figures first, nothing repeated.
const deal: any = { id: "D", brokerId: "b1", businessName: "Beacon Test", isLive: false, demoKey: "t", extractedInfo: beaconInfo };
const kf = buyerKeyFigures(deal, "t2");
assert.ok(kf.length <= 6 && kf.length > 0, JSON.stringify(kf));
const values = kf.map((f) => `${f.label}=${f.value}`);
assert.equal(new Set(kf.map((f) => f.value)).size, kf.length, `no two rows with the same value: ${values.join(" | ")}`);
assert.match(kf[0].label, /revenue|net income|taxable income/i, `headline figures first: ${values.join(" | ")}`);
assert.ok(!values.some((v) => /by year|revenue share/i.test(v)), values.join(" | "));
// A year's lines one per line; anything else one line.
assert.deepEqual(figureLines("2024: $569,522 · 2023: $459,201"), ["2024: $569,522", "2023: $459,201"]);
assert.deepEqual(figureLines("$820,800"), ["$820,800"]);
assert.deepEqual(figureLines("62,480 Community Rx · 104,300 LTC"), ["62,480 Community Rx · 104,300 LTC"]);
ok("F3: buyers' key figures are distinct, readable rows; a year's lines split");

// ── F5: sheet cells ──
assert.match(sheetCellClass("Beacon Specialty Pharmacy — Dispensary revenue by payer, FY2024 (ODB vs private)"), /whitespace-normal/);
assert.match(sheetCellClass("Beacon Specialty Pharmacy — Dispensary revenue by payer, FY2024 (ODB vs private)"), /max-w-\[320px\]/);
assert.match(sheetCellClass("1,983,687"), /whitespace-nowrap/);
assert.match(sheetCellClass("56.1%"), /whitespace-nowrap/);
assert.match(sheetCellClass("(78,000)"), /whitespace-nowrap/);
assert.match(sheetCellClass("2024-12-31"), /whitespace-nowrap/);
assert.match(sheetCellClass(""), /whitespace-nowrap/);
ok("F5: words wrap in a capped column; figures and dates stay on one line");

// ── Over HTTP: F2 (stored page) and F4 (memorandumAvailable) ──
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "t2.pdf"), "x");
fs.writeFileSync(path.join(root, "docs", "mix.xlsx"), "x");
const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
const app = await vdrTestApp({
  root, now,
  docs: [
    { id: "t2", dealId: "D", name: "T2 2023", originalName: "t2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now },
    { id: "mix", dealId: "D", name: "Payer mix FY2024", originalName: "mix.xlsx", category: "financials", fileUrl: "/uploads/docs/mix.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdAt: now },
  ],
  deals: [deal],
  access: [{ id: "dd", dealId: "D", buyerEmail: "jane@n.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now }],
});
await setUpRoom("D", "b1", "auto", app.setupDeps);
const pdf = app.f.items.find((x: any) => x.documentId === "t2")!;
const sheet = app.f.items.find((x: any) => x.documentId === "mix")!;
pdf.prepared = { status: "ready", kind: "pdf", forFile: "0123456789abcdef", pages: [{ w: 1, h: 1, hasText: true }, { w: 1, h: 1, hasText: true }, { w: 1, h: 1, hasText: true }], servedCopy: "sanitised" };
sheet.prepared = { status: "ready", kind: "sheet", forFile: "fedcba9876543210", sheets: [{ name: "Payer mix", rows: 3, cols: 2, firstRow: 1, firstCol: 1 }] };
fs.mkdirSync(vdrCacheDir("D", pdf.id, "0123456789abcdef", root)!, { recursive: true });
fs.mkdirSync(vdrCacheDir("D", sheet.id, "fedcba9876543210", root)!, { recursive: true });
await app.f.store.insertShares([pdf, sheet].map((it: any) => ({ dealId: "D", itemId: it.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "t" })));
for (const it of [pdf, sheet]) {
  const r = await app.call("GET", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${it.id}`);
  assert.equal(r.status, 200, `${it.prepared.kind}: ${JSON.stringify(r.json)}`);
}

let r = await app.call("POST", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${sheet.id}/questions`, { question: "Is the ODB share stable?", page: 1 });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(app.questions.at(-1).vdrPage, null, "a spreadsheet's question is stored without a page");
assert.ok(!JSON.stringify(app.alerts.at(-1)).includes("page 1"), "the broker's alert names no page for a sheet");
r = await app.call("POST", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${pdf.id}/questions`, { question: "What is line 9367?", page: 2 });
assert.equal(app.questions.at(-1).vdrPage, 2, "a PDF keeps its page");
r = await app.call("POST", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${pdf.id}/questions`, { question: "And this?", page: 9 });
assert.equal(app.questions.at(-1).vdrPage, null, "a page the PDF doesn't have is dropped");
// An older row stored with a sheet "page 1" is never shown as one (buyer About, broker list).
app.questions.push({ ...app.questions[0], id: "legacy", question: "Old one", vdrPage: 1 });
r = await app.call("GET", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${sheet.id}`);
assert.ok(r.json.questions.length >= 2 && r.json.questions.every((q: any) => q.page === null), JSON.stringify(r.json.questions));
r = await app.call("GET", `/api/deals/D/data-room/items/${sheet.id}/notes`, undefined, "b1");
assert.equal(r.status, 200);
assert.ok(r.json.questions.length >= 2 && r.json.questions.every((q: any) => q.page === null), JSON.stringify(r.json.questions));
r = await app.call("GET", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${pdf.id}`);
assert.deepEqual(r.json.questions.map((q: any) => q.page), [2, null]);
ok("F2: over HTTP, a sheet's question has no page; a PDF's real page is kept");

// F4: the switch only when the memorandum opens for this link.
r = await app.call("GET", "/api/view/tok-dd-xxxxxxxxxx/data-room");
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.memorandumAvailable, false, "an unpublished CIM: no Memorandum switch");
deal.isLive = true;
r = await app.call("GET", "/api/view/tok-dd-xxxxxxxxxx/data-room");
assert.equal(r.json.memorandumAvailable, true, "published: the switch shows");
ok("F4: memorandumAvailable follows the publish gate");

// ── F6: one round of reads; each file checked once; a tombstone never ──
const events: Array<{ name: string; start: number; end: number }> = [];
const DELAY = 40;
const slow = <T extends (...a: any[]) => Promise<any>>(name: string, fn: T): T =>
  (async (...a: any[]) => {
    const start = performance.now();
    await new Promise((res) => setTimeout(res, DELAY));
    const out = await fn(...a);
    events.push({ name, start, end: performance.now() });
    return out;
  }) as T;
const storeProxy: any = new Proxy(app.f.store, {
  get(target: any, prop: string) {
    const v = target[prop];
    return typeof v === "function" ? slow(`store.${prop}`, v.bind(target)) : v;
  },
});
// A tombstone (the seller took the file away): its file is never looked up.
const gone = { ...pdf, id: "gone-item", documentId: "t2", removedAt: now, removedReason: "seller_removed" };
app.f.items.push(gone);
const looked: string[] = [];
const t0 = performance.now();
const out = await roomAndWaiting({
  store: storeProxy,
  accessRowsForDeal: slow("accessRows", async () => [{ id: "dd", dealId: "D", buyerEmail: "jane@n.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now }] as any),
  requirementsForDeal: slow("requirements", async () => []),
  privateMatters: () => new Map(),
  ddCitedDocumentIds: slow("ddCited", async () => null),
  questionsForDeal: slow("questions", async () => app.questions as any),
  root,
  now: () => now,
  fileExists: (p) => { looked.push(p); return fs.existsSync(p); },
}, deal);
const elapsed = performance.now() - t0;
assert.ok(out.payload.room, "the room loaded");
const lastStart = Math.max(...events.map((e) => e.start));
const firstEnd = Math.min(...events.map((e) => e.end));
assert.ok(events.length >= 10, `every read went through the stubs (${events.length})`);
assert.ok(lastStart < firstEnd, `every read started before any finished (one round): ${events.map((e) => `${e.name}@${Math.round(e.start - t0)}-${Math.round(e.end - t0)}`).join(", ")}`);
assert.ok(elapsed < DELAY * 3, `one round of reads (${Math.round(elapsed)} ms for ${DELAY} ms reads)`);
assert.equal(new Set(looked).size, looked.length, `each file checked once: ${looked.join(", ")}`);
assert.ok(looked.length <= 2, `only the live items' files: ${looked.length}`);
const memo = memoFileExists((p) => p === "a");
assert.equal(memo("a"), true); assert.equal(memo("a"), true); assert.equal(memo("b"), false);
ok(`F6: the tab's reads run in one round (${Math.round(elapsed)} ms with ${DELAY} ms reads), each file checked once, tombstones never`);

app.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\nvdr-checker-r1: ${passed} passed`);
