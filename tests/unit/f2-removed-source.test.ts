// F2-DI-2: deleting a source retires the discrepancies of ANY engine that
// compare it (the check's, the financial analysis'), not only the merge's —
// they must stop blocking generation / publish and stop being put to the
// seller. Settled rows stay; rows about sources still on the deal stay.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-removed-source.test.ts
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { removeSourceFacts } from "../../server/documents/cleanup";
import { ensureDiscrepancyGate } from "../../server/cim/discrepancy-check";
import { rowsWithRemovedSource, planMergeRowSupersession } from "../../server/documents/merge-conflicts";

let deal: any;
let docs: any[];
let rows: any[];
const s = storage as any;
s.getDeal = async () => (deal ? JSON.parse(JSON.stringify(deal)) : undefined);
s.updateDeal = async (_id: string, patch: any) => { deal = { ...deal, ...JSON.parse(JSON.stringify(patch)) }; return deal; };
s.getDocumentsByDeal = async () => docs.map((d) => ({ ...d }));
s.getDocument = async (id: string) => docs.find((d) => d.id === id);
s.deleteDocument = async (id: string) => { docs = docs.filter((d) => d.id !== id); };
s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
s.updateDiscrepancy = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);
s.getDocumentRequirementsByDeal = async () => [];
s.updateDocumentRequirement = async () => undefined;
// What the interview's knowledge base reads (storage.getResolvedDiscrepancies).
const interviewRows = () => rows.filter((r) => ["resolved", "accepted", "ask_seller"].includes(r.status));

const doc = (id: string, name: string) => ({ id, dealId: "D", name, category: "financial", subcategory: null, sourceKind: "document", visibility: "shared", extractedText: null, extractedData: null, fileUrl: null, status: "completed", sourceMeta: null, isProcessed: false, createdAt: new Date(1) });
const row = (id: string, over: any) => ({
  id, dealId: "D", createdAt: new Date("2026-09-20"), resolvedValue: null, category: "financial", documentId: null, documentName: null, sideSources: null, factKey: null, factYear: null, ...over,
});

deal = { id: "D", businessName: "Probe Co", industry: "Manufacturing", extractedInfo: {}, discrepancyCheckedAt: null, discrepancyCheckSources: null };
docs = [doc("pl", "2024 P&L (wrong client)"), doc("lease", "Lease agreement")];
rows = [
  // The analysis' critical conflict against the wrong P&L.
  row("A", { source: "financial_analysis", status: "open", severity: "critical", field: "Revenue 2024", interviewValue: "$2.3M — Interview", documentValue: "$1.2M — 2024 P&L", documentId: "pl", documentName: "2024 P&L (wrong client)", factKey: "revenueByYear", factYear: "2024", sideSources: { interview: { kind: "interview" }, document: { kind: "document", documentId: "pl" } } }),
  // Routed to the seller, about the same file.
  row("Q", { source: "financial_analysis", status: "ask_seller", severity: "significant", field: "Owner salary", interviewValue: "$150,000", documentValue: "$95,000 — 2024 P&L", documentId: "pl", documentName: "2024 P&L (wrong client)" }),
  // The check's critical row, pointing at the file only through its side sources.
  row("C", { source: "interview", status: "seller_responded", severity: "critical", field: "Gross margin", interviewValue: "40%", documentValue: "22%", sideSources: { document: { kind: "document", documentId: "pl" } } }),
  // Settled rows are the broker's record: kept.
  row("S", { source: "financial_analysis", status: "resolved", severity: "critical", field: "EBITDA 2024", interviewValue: "$400K", documentValue: "$210K", documentId: "pl", documentName: "2024 P&L (wrong client)", resolvedValue: "$400,000" }),
  // About a source still on the deal: untouched.
  row("L", { source: "interview", status: "open", severity: "critical", field: "Lease term", interviewValue: "10 years", documentValue: "5 years", documentId: "lease", documentName: "Lease agreement" }),
  // A model id with no name the row took from a real document: never trusted.
  row("X", { source: "financial_analysis", status: "open", severity: "minor", field: "Rent", interviewValue: "$4,000", documentValue: "$4,500", documentId: "00000000-dead-beef-0000-000000000000", documentName: null }),
];

// Pure rule.
assert.deepEqual(rowsWithRemovedSource(rows as any, [{ id: "lease" }]).sort(), ["A", "C", "Q"]);
assert.deepEqual(planMergeRowSupersession(rows as any, {}, docs.filter((d) => d.id !== "pl") as any).sort(), ["A", "C", "Q"]);
assert.deepEqual(planMergeRowSupersession(rows as any, {}, docs as any), [], "nothing changes while the file is on the deal");

// The broker deletes the wrong P&L (the route deletes the row, then cleans up).
await s.deleteDocument("pl");
await removeSourceFacts("D", "pl");
const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
assert.deepEqual(status, { A: "superseded", Q: "superseded", C: "superseded", S: "resolved", L: "open", X: "open" });
assert.ok(!interviewRows().some((r) => r.id === "Q"), "the routed question about the deleted file is no longer put to the seller");

// The gate only sees the lease conflict — the deleted file's criticals no longer block.
rows = rows.map((r) => (r.id === "L" ? { ...r, status: "resolved", resolvedValue: "10 years" } : r));
await ensureDiscrepancyGate("D");
console.log("✓ a deleted source's discrepancies of every engine are retired: generation and the interview no longer see them");

// And at the gate itself, for a row left behind by a delete before this fix.
rows.push(row("OLD", { source: "financial_analysis", status: "open", severity: "critical", field: "Revenue 2023", documentId: "gone", documentName: "Old P&L" }));
await ensureDiscrepancyGate("D");
assert.equal(rows.find((r) => r.id === "OLD").status, "superseded");
console.log("✓ the gate retires a row whose source was removed earlier instead of blocking on it");

console.log("f2-removed-source: all passed");
process.exit(0);
