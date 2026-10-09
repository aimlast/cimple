/**
 * vdr spec §5.4, §6.3, §9.6: Cimple's notes on a document. No AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-notes.test.ts
 *
 *  - the facts whose recorded source is the document (a by-year map only for
 *    the years it stated)
 *  - buyers' key figures: never from a broker-only source, never a held
 *    person or sensitive detail, figures only, at most 6
 *  - "Used in the CIM": pages that print the document's figures (a big money
 *    figure, or two matches — a stray percentage never links a page)
 *  - "Checked against other documents": resolved differences with the
 *    recorded reason, open ones pointing to the Financials tab, the same
 *    figure in another shared document
 *  - the notes route (broker) and the About panel (buyer) over HTTP
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-notes-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";

const { documentFacts, buyerKeyFigures, documentCimLinks, brokerChecks, sectionText, factLabel, valueText } = await import("../../server/vdr/analysis");
const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");

const info: any = {
  revenueByYear: { "2022": "$27,400,000", "2023": "$29,180,000" },
  netIncome: "$665,915",
  taxableIncome: "$591,500",
  ownerHealth: "The owner's cancer diagnosis means he wants out by spring ($0 impact)",
  employees: "Daniel Okafor (lead pharmacist) — 14 staff, payroll $1,240,000",
  loiPrice: "$3,050,000",
  ebitdaMargin: "8.6%",
  industry: "Pharmacy",
  _fieldSources: {
    revenueByYear: { source: "document", documentId: "t2-2023", years: { "2022": { source: "document", documentId: "t2-2022" }, "2023": { source: "document", documentId: "t2-2023" } } },
    netIncome: { source: "document", documentId: "t2-2023" },
    taxableIncome: { source: "document", documentId: "t2-2023" },
    ownerHealth: { source: "document", documentId: "t2-2023" },
    employees: { source: "document", documentId: "t2-2023" },
    loiPrice: { source: "crm", documentId: "t2-2023", brokerOnly: true },
    ebitdaMargin: { source: "document", documentId: "t2-2023" },
    industry: { source: "broker" },
  },
  _brokerPrivateNotes: [{ note: "Daniel Okafor wants a stake — keep out of the CIM", documentId: "t2-2023" }],
};
const deal: any = { id: "D", brokerId: "b1", businessName: "Beacon Test", isLive: true, extractedInfo: info };

// ── Facts from one document ──
const facts = documentFacts(info, "t2-2023");
assert.deepEqual(facts.map((f) => f.key).sort(), ["ebitdaMargin", "employees", "loiPrice", "netIncome", "ownerHealth", "revenueByYear", "taxableIncome"]);
assert.equal(facts.find((f) => f.key === "revenueByYear")!.text, "2023: $29,180,000", "only the year this document stated");
assert.deepEqual(documentFacts(info, "t2-2022").map((f) => f.text), ["2022: $27,400,000"]);
assert.equal(factLabel("revenueByYear"), "Revenue by year");
assert.equal(valueText(29180000), "29,180,000");

// ── Buyers' key figures ──
const kf = buyerKeyFigures(deal, "t2-2023", new Set());
const labels = kf.map((f) => f.label);
assert.ok(labels.includes("Revenue by year") && labels.includes("Net income") && labels.includes("Taxable income"), JSON.stringify(kf));
assert.ok(!labels.includes("Loi price"), "never from a broker-only source");
assert.ok(!labels.includes("Owner health"), "never a sensitive detail");
assert.ok(!labels.includes("Employees"), "never naming a held person");
assert.ok(!labels.includes("Industry"), "figures only");
assert.ok(kf.length <= 6);
assert.ok(!JSON.stringify(kf).includes("Okafor") && !JSON.stringify(kf).includes("cancer"));

// ── Used in the CIM ──
const sections = [
  sectionText({ id: "s-fin", sectionTitle: "Financial Performance", aiDraftContent: "Revenue reached $29.18 million in 2023.", layoutData: { rows: [{ label: "Net income", values: ["665,915"] }] } }),
  sectionText({ id: "s-pct", sectionTitle: "Margins", aiDraftContent: "EBITDA margin of 8.6% held steady." }),
  sectionText({ id: "s-none", sectionTitle: "History", aiDraftContent: "Founded in 1998." }),
];
const links = documentCimLinks(facts, sections);
assert.deepEqual(links.links.map((l) => l.sectionId), ["s-fin"], "a stray percentage never links a page");
assert.ok(links.inCim.has("revenueByYear") && links.inCim.has("netIncome"));
assert.ok(!links.inCim.has("taxableIncome"));

// ── Checks ──
const discrepancies: any[] = [
  { id: "x1", dealId: "D", field: "netIncome", factKey: "netIncome", factYear: "2023", documentId: "t2-2023", documentValue: "$665,915", interviewValue: "$701,200", status: "resolved", resolvedAt: new Date("2026-07-02T00:00:00Z"), brokerNotes: "Tax adjustments for capital cost allowance", sideSources: null },
  { id: "x2", dealId: "D", field: "interest expense", factKey: "interestExpense", factYear: "2023", documentId: null, sideSources: { document: { documentId: "t2-2023" } }, status: "open" },
  { id: "x3", dealId: "D", field: "old", factKey: "old", documentId: "t2-2023", status: "superseded" },
  { id: "x4", dealId: "D", field: "unrelated", factKey: "x", documentId: "other", status: "open" },
];
const others: any[] = [
  { id: "fs-2023", name: "Financial statements FY2023", visibility: "shared", extractedData: { revenueByYear: { "2023": "29,180,000" } } },
  { id: "crm", name: "CRM note", visibility: "broker_only", extractedData: { netIncome: "$665,915" } },
];
const checks = brokerChecks({ id: "t2-2023", name: "T2 2023" }, facts, discrepancies, others);
assert.deepEqual(checks.map((c) => c.tone), ["resolved", "open", "match"]);
assert.equal(checks[0].text, "Net income 2023: $665,915 vs $701,200. Resolved Jul 2: Tax adjustments for capital cost allowance.");
assert.equal(checks[1].text, "Open difference: Interest expense 2023. See the Financials tab.");
assert.equal(checks[2].text, "Revenue by year matches Financial statements FY2023.");

// ── Over HTTP ──
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "t2.pdf"), "x");
const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
const app = await vdrTestApp({
  root, now,
  docs: [{ id: "t2-2023", dealId: "D", name: "T2 2023", originalName: "t2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now }, { id: "fs-2023", dealId: "D", ...others[0], fileUrl: null, createdAt: now }],
  deals: [deal],
  access: [{ id: "dd", dealId: "D", buyerEmail: "jane@n.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now }],
  discrepancies,
  sections: [{ id: "s-fin", dealId: "D", sectionTitle: "Financial Performance", aiDraftContent: "Revenue reached $29.18 million in 2023.", layoutData: null, isVisible: true }],
  questions: [{ id: "q1", dealId: "D", buyerAccessId: "dd", question: "What is line 9367?", status: "pending_broker", vdrItemId: "__set_below__", vdrPage: 3, vdrTeamMemberId: null, answerScope: "private", createdAt: now }],
});
await setUpRoom("D", "b1", "auto", app.setupDeps);
const it = app.f.items.find((x) => x.documentId === "t2-2023")!;
app.questions[0].vdrItemId = it.id;
it.prepared = { status: "ready", kind: "image", forFile: "0123456789abcdef", pages: [{ w: 1, h: 1, hasText: true }] };
fs.mkdirSync(vdrCacheDir("D", it.id, "0123456789abcdef", root)!, { recursive: true });
let r = await app.call("GET", `/api/deals/D/data-room/items/${it.id}/notes`, undefined, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.ok(r.json.keyFigures.some((k: any) => k.key === "revenueByYear" && k.inCim));
assert.ok(r.json.keyFigures.some((k: any) => k.key === "loiPrice"), "the broker sees every fact from the document");
assert.deepEqual(r.json.cimLinks, [{ sectionId: "s-fin", title: "Financial Performance" }]);
assert.equal(r.json.checks[0].tone, "resolved");
assert.deepEqual(r.json.questions.map((q: any) => [q.who, q.page, q.statusLabel]), [["Northgate", 3, "Needs your answer"]]);
assert.equal(r.json.summary.remainingToday, 60);
assert.equal((await app.call("GET", `/api/deals/D/data-room/items/${it.id}/notes`, undefined, "b2")).status, 404, "another brokerage");
// The buyer's About panel.
await app.f.store.insertShares([{ dealId: "D", itemId: it.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "t" }]);
r = await app.call("GET", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${it.id}`);
assert.equal(r.status, 404, "a private note came from this document: held until the broker checks it (fail-closed)");
assert.equal((await app.call("POST", `/api/deals/D/data-room/items/${it.id}/checked`, {}, "b1")).status, 200);
r = await app.call("GET", `/api/view/tok-dd-xxxxxxxxxx/data-room/items/${it.id}`);
assert.equal(r.status, 200);
assert.ok(r.json.keyFigures.length > 0 && !JSON.stringify(r.json.keyFigures).includes("3,050,000"), "buyer-safe figures only");
assert.deepEqual(r.json.usedIn, [{ sectionId: "s-fin", title: "Financial Performance" }]);
assert.deepEqual(r.json.checks, [], "no dd checks until the dd stream is merged");
assert.ok(!JSON.stringify(r.json).includes("capital cost allowance"), "the broker's discrepancy notes never reach a buyer");
app.close();

console.log("vdr-notes: all passed");
