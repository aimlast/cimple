/**
 * R7 — the broker's document list must not ship (or read) every document's
 * full extracted text: the Overview tab polls it every 2.5 s while anything
 * is being read. Measured read-only on production: Pacific 324 KB → 22 KB,
 * Lakeshore 547 KB → 18 KB per poll, same rows and read-status metadata.
 * No database (the query is only built, never run).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-doclist.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { documentListQuery, toDocumentListRow } from "../../server/documents/document-list";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

{
  const { sql } = documentListQuery("d1").toSQL();
  assert.ok(!/"extracted_text"/.test(sql), sql);
  assert.ok(!/"extracted_data",|"extracted_data" from/.test(sql), "the whole extracted-data blob is never selected");
  assert.match(sql, /->>'summary'/);
  assert.match(sql, /"source_meta"/, "read status (partial read / failed) still comes back");
  assert.match(sql, /"status"/);
  ok("the list's query never reads the extracted text or the full extracted data");
}

{
  const full: any = {
    id: "doc1", dealId: "d1", name: "GL Detail.xlsx", status: "extracted", sourceMeta: { partialRead: { reason: "long" } },
    extractedText: "x".repeat(2_000_000),
    extractedData: { summary: "General ledger 2021–2024", _documentType: "General ledger", fleetDetails: "y".repeat(3000), _privateNotes: ["z"] },
  };
  const row = toDocumentListRow(full) as any;
  assert.equal(row.extractedText, undefined);
  assert.deepEqual(row.extractedData, { summary: "General ledger 2021–2024", _documentType: "General ledger" });
  assert.deepEqual(row.sourceMeta, full.sourceMeta);
  assert.ok(JSON.stringify(row).length < 500);
  assert.equal(toDocumentListRow({ ...full, extractedData: null }).extractedData, null);
  ok("a list row keeps its columns and read status, drops the text and extracted fields");
}

{
  const routes = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf8");
  const start = routes.indexOf('app.get("/api/deals/:dealId/documents"');
  const body = routes.slice(start, routes.indexOf("app.", start + 20));
  assert.ok(body.includes("listDocumentsForBroker("));
  assert.ok(!body.includes("getDocumentsByDeal("));
  ok("GET /api/deals/:dealId/documents returns the slim list");
}

console.log(`f2-resilience-doclist: ${passed} passed`);
process.exit(0);
