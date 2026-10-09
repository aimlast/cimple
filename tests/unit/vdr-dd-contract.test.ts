/**
 * The dd ↔ vdr contract (vdr spec §11.1.9, INTEGRATION §2.6) — vdr owns this
 * test. No database, no AI, no browser (server-rendered chips).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-dd-contract.test.ts
 *
 *  - The chip takes no title: a broker-only, an unshared and an unknown
 *    document resolve to the SAME bare answer, and the rendered chip is
 *    exactly `citationLabel(ref)` — no document name anywhere in the markup
 *  - a visible document → the ROOM's title + " · p. 3"; a replaced one →
 *    no page; outside a provider → the neutral label as plain text; the
 *    broker preview → the document's own name
 *  - citationLabel's fixed vocabulary; periods validated; docKindFor
 *  - dd's checks: a counterpart the reader can't open is "another document",
 *    one they can is its room title; checks only in due diligence
 *  - the DD-cited fallback (fact tracing over the DD version): a figure the
 *    DD sections print cites its document; broker-only never; no DD version → null
 */
import "./react-global";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-dd-contract-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";
delete process.env.RESEND_API_KEY;
(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout, clearTimeout, location: { href: "http://x/" } };

const { citationLabel, cleanPeriod } = await import("../../shared/vdr");
const { docKindFor } = await import("../../server/vdr/auto-file");
const { VdrCitationChip, visibleChipText } = await import("../../client/src/components/vdr/VdrCitationChip");
const { VdrLinkContext } = await import("../../client/src/components/vdr/VdrLinkContext");
const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");
const { buyerAboutExtras } = await import("../../server/vdr/buyer-room");
const { vdrBuyerGate, decideForGate } = await import("../../server/vdr/access");
const { citedByFactTracing } = await import("../../server/vdr/dd-adapter");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
for (const n of ["t2.pdf", "fs.pdf", "priv.pdf", "lease.pdf"]) fs.writeFileSync(path.join(root, "docs", n), "%PDF-1.4 fixture");
const docs: any[] = [
  { id: "t2", dealId: "D", name: "T2 corporate income tax return 2023", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "fs", dealId: "D", name: "Harbourline audited statements FY2023", originalName: "FS.pdf", category: "financials", fileUrl: "/uploads/docs/fs.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "priv", dealId: "D", name: "Seller's secret valuation memo", originalName: "memo.pdf", category: "financials", fileUrl: "/uploads/docs/priv.pdf", mimeType: "application/pdf", visibility: "broker_only", createdAt: now },
  { id: "lease", dealId: "D", name: "Ridgeway Industrial lease", originalName: "Lease.pdf", category: "legal", fileUrl: "/uploads/docs/lease.pdf", mimeType: "application/pdf", createdAt: now },
];
const deals: any[] = [{ id: "D", brokerId: "b1", businessName: "Pacific Test Logistics", isLive: true, extractedInfo: {}, demoKey: null }];
const access: any[] = [
  { id: "dd", dealId: "D", buyerEmail: "jane@northgate.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-aaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "full", dealId: "D", buyerEmail: "sam@full.invalid", buyerName: "Sam", buyerCompany: "FullCo", accessToken: "tok-full-aaaaaaaaaa", accessLevel: "named", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
];
const app = await vdrTestApp({ root, docs, deals, access, now });
const { f, call } = app;
await setUpRoom("D", "b1", "auto", { store: f.store, enqueue: () => {}, now: () => now });
const itemOf = (docId: string) => f.items.find((i: any) => i.documentId === docId && !i.removedAt)!;
for (const it of f.items) {
  it.prepared = { status: "ready", kind: "pdf", forFile: "0123456789abcdef", pages: [{ w: 100, h: 140, hasText: true }], personal: { count: 0, kinds: [], pages: [] } };
  const dir = vdrCacheDir(it.dealId, it.id, "0123456789abcdef", root)!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "p1.webp"), "webp");
}
await f.store.insertShares([{ dealId: "D", itemId: itemOf("t2").id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "test" }]);
await f.store.updateItem(itemOf("t2").id, { title: "1.2 · T2 return 2023 (room title)" } as any);

/** Renders a chip against fixed answers (what the provider would hold after its lookup). */
function chip(ref: any, answers: Record<string, any> | null, kind: "buyer" | "broker" = "buyer"): string {
  const el = React.createElement(VdrCitationChip, { docRef: ref });
  if (!answers) return renderToStaticMarkup(el);
  const api = { source: kind === "buyer" ? { kind: "buyer", token: "tok" } : { kind: "broker", dealId: "D" }, resolved: (id: string) => answers[id], request: () => {}, open: () => {}, askFor: async () => "asked" as const };
  return renderToStaticMarkup(React.createElement(VdrLinkContext.Provider, { value: api as any }, el));
}
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

await test("citationLabel: a fixed vocabulary, periods validated, never a title", () => {
  assert.equal(citationLabel({ kind: "tax_return", period: "2023" }), "Tax return 2023");
  assert.equal(citationLabel({ kind: "tax_return", period: "FY2023" }), "Tax return FY2023");
  assert.equal(citationLabel({ kind: "financial_statements", period: "2024-06" }), "Financial statements Jun 2024");
  assert.equal(citationLabel({ kind: "bank_statement", period: "June 2024" as any }), "Bank statement", "a free-text period is dropped");
  assert.equal(citationLabel({ kind: "other", period: "2023" }), "A supporting document");
  assert.equal(citationLabel({ kind: "Harbourline secrets" as any, period: null }), "A supporting document");
  assert.equal(cleanPeriod("2023; DROP"), null);
});

await test("docKindFor: chip kinds agree with the room's folders", () => {
  assert.equal(docKindFor({ name: "T2 corporate income tax return 2023", category: "financials" } as any), "tax_return");
  assert.equal(docKindFor({ name: "Financial statements FY2023", category: "financials" } as any), "financial_statements");
  assert.equal(docKindFor({ name: "Warehouse lease", category: "legal" } as any), "lease");
});

await test("resolve + chip: broker-only, unshared and unknown look the same — the neutral label, no name", async () => {
  const r = await call("GET", "/api/view/tok-dd-aaaaaaaaaaaa/data-room/resolve?documentIds=priv,lease,nope,fs");
  assert.equal(r.status, 200);
  for (const id of ["priv", "lease", "nope", "fs"]) assert.deepEqual(r.json.documents[id], { available: false });
  for (const [id, kind, period] of [["priv", "financial_statements", "2023"], ["lease", "lease", null], ["nope", "tax_return", "2022"], ["fs", "financial_statements", "FY2023"]] as const) {
    const ref = { documentId: id, kind, period };
    const html = chip(ref, r.json.documents);
    assert.equal(text(html), citationLabel(ref), id);
    for (const word of ["secret", "valuation", "Ridgeway", "Harbourline", "memo"]) assert.ok(!html.includes(word), `${id}: no "${word}"`);
  }
});

await test("a visible document → the room's title and the page; replaced → no page; no provider → plain label", async () => {
  const r = await call("GET", "/api/view/tok-dd-aaaaaaaaaaaa/data-room/resolve?documentIds=t2");
  const ref = { documentId: "t2", kind: "tax_return", period: "2023", page: 3 };
  assert.equal(text(chip(ref, r.json.documents)), "1.2 · T2 return 2023 (room title) · p. 3");
  assert.equal(visibleChipText("New T2", 3, true), "New T2", "a replaced document opens without the old page");
  const plain = chip(ref, null);
  assert.equal(text(plain), "Tax return 2023");
  assert.ok(plain.includes('data-vdr-chip="plain"'));
  // While the lookup runs: the neutral label too (never a guess).
  assert.equal(text(chip(ref, {})), "Tax return 2023");
});

await test("broker preview: the document's own name (private ones marked), linking into the Data room tab", async () => {
  const r = await call("GET", "/api/deals/D/data-room/resolve?documentIds=priv,t2", undefined, "b1");
  const html = chip({ documentId: "priv", kind: "financial_statements", period: "2023" }, r.json.documents, "broker");
  assert.match(text(html), /Seller's secret valuation memo\s*· private/);
  const t2 = chip({ documentId: "t2", kind: "tax_return", period: "2023", page: 2 }, r.json.documents, "broker");
  assert.ok(t2.includes(`href="/deal/D/data-room?item=${itemOf("t2").id}"`));
});

await test("dd's checks: a counterpart the reader can't open is 'another document'; due diligence only", async () => {
  const deps = { store: f.store, accessByToken: async (t: string) => access.find((a) => a.accessToken === t), accessRowsForDeal: async () => access, getDeal: async () => deals[0], now: () => now, root };
  const ddChecks = async () => [
    { label: "Revenue 2023", thisValue: "$29,180,000", other: { documentId: "fs" }, otherValue: "$29,212,000", status: "differs" as const, explanation: "The statements include a year-end accrual." },
    { label: "Net income 2023", thisValue: "$1,398,000", other: { documentId: "t2" }, otherValue: "$1,398,000", status: "match" as const, explanation: null },
  ];
  const gate = await vdrBuyerGate(deps as any, "tok-dd-aaaaaaaaaaaa");
  const { snap, decided } = await decideForGate(deps as any, gate);
  const one = decided.find((d) => d.item.documentId === "t2")!;
  const out = await buyerAboutExtras({ questionsForDeal: async () => [], servedSections: async () => [], ddChecks }, gate, snap, decided, one, { preview: false });
  assert.equal(out.checks!.length, 2);
  assert.match(out.checks![0].text, /\$29,212,000 in another document\. The statements include a year-end accrual\./);
  assert.ok(!out.checks![0].text.includes("Harbourline"), "the hidden counterpart is never named");
  assert.match(out.checks![1].text, /matches 1\.2 · T2 return 2023 \(room title\)/);
  // A Full CIM reader (normal mode) gets no checks. (They'd need the room on; the mode decides.)
  const fullGate = { ...gate, mode: "normal" as const };
  const none = await buyerAboutExtras({ questionsForDeal: async () => [], servedSections: async () => [], ddChecks }, fullGate as any, snap, decided, one, { preview: false });
  assert.deepEqual(none.checks, []);
});

await test("the DD-cited fallback: figures the DD sections print cite their document; private files never; no DD version → null", async () => {
  const info = {
    revenue2023: 29_180_000,
    netIncome2023: 1_398_220,
    secretValuation: 31_450_000,
    leaseRent: 18_440,
    _fieldSources: {
      revenue2023: { kind: "document", documentId: "t2" },
      netIncome2023: { kind: "document", documentId: "t2" },
      secretValuation: { kind: "document", documentId: "priv" },
      leaseRent: { kind: "document", documentId: "lease" },
    },
  };
  const tracing = (overrides: any[]) => ({
    getDeal: async () => ({ id: "D", extractedInfo: info }),
    ddOverrides: async () => overrides,
    sections: async () => [{ id: "s1", sectionTitle: "Financial overview", isVisible: true }],
    documents: async () => docs as any,
  });
  assert.equal(await citedByFactTracing("D", tracing([])), null, "no DD version yet");
  const ids = await citedByFactTracing("D", tracing([{ cimSectionId: "s1", contentOverride: "Revenue of $29,180,000 (T2) and net income of $1,398,220. Valued at $31,450,000.", layoutData: null }]));
  assert.deepEqual(ids, ["t2"], "the T2's figures are printed; the lease's aren't; the private file is never cited");
});

await test("gl's link helper: vdrDocumentHref (rows capped at 500) round-trips through parseRoomLink", async () => {
  const { vdrDocumentHref, parseRoomLink, vdrAvailable } = await import("../../client/src/components/vdr/links");
  assert.equal(vdrAvailable, true);
  const href = vdrDocumentHref({ token: "tok/abc", documentId: "doc-1", ledgerRows: [12, 48, -1, 3.5], fy: "FY2024", page: 2 });
  assert.equal(href, "/view/tok%2Fabc/data-room?document=doc-1&page=2&rows=12%2C48&fy=FY2024");
  const back = parseRoomLink(href.split("?")[1]);
  assert.deepEqual(back, { itemId: null, documentId: "doc-1", page: 2, rows: [12, 48], sheet: null, fy: "FY2024", needle: null });
  const many = vdrDocumentHref({ token: "t", documentId: "d", ledgerRows: Array.from({ length: 900 }, (_, i) => i + 1) });
  assert.equal(parseRoomLink(many.split("?")[1]).rows!.length, 500);
  assert.equal(parseRoomLink("doc=../../x&page=-3&fy=2024; drop").itemId, null);
  assert.equal(parseRoomLink("doc=../../x&page=-3&fy=2024; drop").fy, null);
});

app.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\nvdr-dd-contract: ${passed} passed`);
