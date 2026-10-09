/**
 * gl spec §12.1 test 27: a general ledger or an add-back's support document
 * is never a statement, never a tax document, never "added since" the
 * analysis, and its role in an analysis is "other".
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { analysisSourceRole, analysisSourceStatus, isFinancialStatementDoc, isTaxDocument, isGlOrSupportDoc } from "../../server/financial/source-status";

const gl = { id: "g", name: "General Ledger 2024 with taxes", category: "financials", subcategory: "general_ledger", isProcessed: true, extractedText: "General ledger export (QuickBooks Online). 48,213 entries…" };
const t4 = { id: "t", name: "T4 2024 Dan", category: "financials", subcategory: "addback_support", isProcessed: true, extractedText: "Box 14 Employment income 240,000.00" };
const pnl = { id: "p", name: "2024 P&L.pdf", category: "financials", subcategory: null, isProcessed: true, extractedText: "Revenue …" };

await test("ledgers and support documents are not statements or tax documents", () => {
  assert.equal(isGlOrSupportDoc(gl), true);
  assert.equal(isFinancialStatementDoc(gl), false);
  assert.equal(isFinancialStatementDoc(t4), false);
  assert.equal(isTaxDocument(gl), false, "a 'tax' word in a ledger's name doesn't make it a return");
  assert.equal(isFinancialStatementDoc(pnl), true);
  assert.equal(analysisSourceRole(gl), "other");
});

await test("a ledger uploaded after the analysis never makes it 'out of date'", () => {
  const status = analysisSourceStatus({ sourceDocumentIds: [{ id: "p", role: "statements" }] }, [pnl, gl, t4]);
  assert.deepEqual(status.added, []);
  assert.equal(status.message, null);
});

done("source-status-gl");
