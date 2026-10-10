/**
 * vdr spec §4.7: the deterministic filing rules, on the real titles of the
 * fictional demo deals (literals; no DB). 72 of 72 land by a rule.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-auto-file.test.ts
 */
import assert from "node:assert/strict";
import { presetFor, docKindFor, planAutoFile, presetFolderRows } from "../../server/vdr/auto-file";
import { VDR_PRESET_FOLDERS, isRoomMaterial } from "../../shared/vdr";

type Case = [string, string, string, string]; // name, category, extracted document type, expected preset
const CASES: Case[] = [
  // Pacific Coast Logistics
  ["Financial statements FY2022 (review engagement, Harmon Bains LLP)", "financials", "Financial Statements (Review Engagement)", "financial.statements"],
  ["Financial statements FY2023 (review engagement, Harmon Bains LLP)", "financials", "Financial Statements (Reviewed)", "financial.statements"],
  ["Financial statements FY2024 (review engagement, Harmon Bains LLP)", "financials", "Financial Statements (Review Engagement)", "financial.statements"],
  ["T2 corporate income tax return 2022", "financials", "T2 Corporation Income Tax Return (Canada)", "financial.tax"],
  ["T2 corporate income tax return 2023", "financials", "T2 Corporation Income Tax Return (Canadian corporate tax return)", "financial.tax"],
  ["T2 corporate income tax return 2024", "financials", "T2 Corporation Income Tax Return (Canada)", "financial.tax"],
  ["Customer revenue by year FY2022–FY2024 (top 10 + service lines)", "financials", "Revenue and customer concentration report (multi-sheet Excel workbook)", "financial.revenue"],
  ["Warehouse lease — 19220 Campbell Ridge Drive (15 yrs + 2×5-yr options)", "legal", "Industrial Lease Agreement", "legal.property"],
  ["Minute book excerpt (certified)", "legal", "Corporate Minute Book (Certified Excerpt) - Legal/Governance Document", "legal.corporate"],
  ["Fleet list — power units, trailers, equipment (Dec 31, 2024)", "operations", "Operations document — Fleet inventory & asset register", "operations.assets"],
  ["Driver roster summary 2024 (IDs only) + all-staff headcount", "operations", "Driver roster and operations summary", "people.staff"],
  ["Safety & CVSA compliance summary 2022–2024", "operations", "Safety & Compliance Summary (internal operations document)", "compliance"],
  // Beacon Pharmacy
  ["LTC & retirement home contracts summary (14 homes)", "operations", "Operations document - Long-Term Care & Retirement Home Contracts Summary", "legal.contracts"],
  ["Payer mix & monthly volumes FY2024 (ODB vs private)", "financials", "Payer mix and financial summary workbook", "financial.revenue"],
  ["Regulatory, accreditation & OCP inspection summary", "legal", "Regulatory, Accreditation & Inspection Summary (prepared by management for sale process)", "compliance"],
  ["Staff list & payroll reconciliation (Feb 2025)", "operations", "Staff list / HR operations document", "people.staff"],
  ["Premises lease — Unit 3, 1742 Merivale Road (2019–2029)", "legal", "Commercial lease agreement", "legal.property"],
  ["T2 corporate tax return 2023 (summary copy)", "financials", "T2 Corporation Income Tax Return", "financial.tax"],
  // Lakeshore Home Comfort
  ["Licensing, registration & insurance summary (TSSA, WSIB, insurance)", "legal", "Licensing, Registration & Insurance Summary (Legal/Compliance Document)", "compliance"],
  ["Staff roster with technician licences", "operations", "Operations / HR summary - staff roster and licensing", "people.staff"],
  ["Comfort Club membership report", "operations", "Membership operations report - Comfort Club recurring revenue program", "financial.revenue"],
  ["Shop lease - 240 Bayfront Commerce Drive (2018-2028)", "legal", "Industrial Lease Agreement", "legal.property"],
  ["Compiled financial statements FY2022", "financials", "Audited Financial Statements", "financial.statements"],
  // Clearwater Physio
  ["Payer mix, location P&L, seasonality and AR report FY2024", "financials", "Financial Report - Payer Mix, Location P&L and Receivables", "financial.revenue"],
  ["Minute book excerpt - articles, registers, resolutions", "legal", "Corporate Minute Book (excerpts) - legal/governance document", "legal.corporate"],
  // Harborview IT
  ["MRR schedule by client (Mar 31, 2025)", "financials", "Internal financials spreadsheet - MRR schedule and recurring revenue report", "financial.revenue"],
  ["Master Services Agreement - client template v2024.2", "legal", "Legal Agreement - Master Services Agreement (MSA) Template", "legal.contracts"],
  ["Org chart, staff list and headcount summary", "operations", "Operations/HR Document - Staff List", "people.staff"],
  // Great Lakes Plastics
  ["Quality certifications and performance summary (ISO 13485, IATF 16949, cleanroom)", "operations", "Operations document - Quality Management System certifications and performance report", "compliance"],
  ["Form 1120-S summary — tax year 2023 (mock)", "financials", "S Corporation Tax Return (Form 1120-S) - 2023", "financial.tax"],
  ["Injection molding press list (38 presses, utilization, FMV estimate)", "operations", "Operations document - Equipment inventory and asset list", "operations.assets"],
  ["Operating agreement summary (shareholders' agreement, articles, code of regulations)", "legal", "Legal governance summary - Shareholders' Agreement, Articles of Incorporation, and Code of Regulations", "legal.corporate"],
  // Ridgeline Metal (literals from the spec)
  ["AR aging", "financials", "", "financial.debt"],
  ["WIP & backlog report", "financials", "", "financial.revenue"],
  // Northbeam Landscaping
  ["Payroll summary 2024 (staff, seasonal headcount, reconciliation)", "operations", "Payroll summary / operations document", "people.staff"],
  ["Top 20 commercial contracts - FY2024 values and renewal dates", "operations", "Operations document - Commercial contracts analysis", "legal.contracts"],
  ["Equipment and vehicle list with estimated FMV (Feb 2025)", "operations", "Equipment and Vehicle List (Operations Document)", "operations.assets"],
  ["Industrial lease - 41 Hartwell Industrial Way (2021-2026)", "legal", "Industrial Lease Agreement", "legal.property"],
];
for (const [name, category, dtype, expected] of CASES) {
  const r = presetFor({ name, originalName: name, category, extractedData: { _documentType: dtype } });
  assert.equal(r.key, expected, `${name} → ${r.key}, expected ${expected}`);
  assert.equal(r.byRule, true, `${name} must land by a rule, not the fallback`);
}
// Rule order: add-back support (gl's ask) before tax; a ledger by name.
assert.equal(presetFor({ name: "2024 T4 summary", subcategory: "addback_support", category: "financials" }).key, "financial.gl");
assert.equal(presetFor({ name: "General ledger FY2024", originalName: "GL export.xlsx", category: "financials" }).key, "financial.gl");
assert.equal(presetFor({ name: "Trial balance", category: "financials" }).key, "financial.gl");
assert.equal(presetFor({ name: "Bank statements Jan–Dec 2024", category: "financials" }).key, "financial.bank");
assert.equal(presetFor({ name: "Notice of assessment 2023", category: "financials" }).key, "financial.tax");
assert.equal(presetFor({ name: "Employment agreement — GM", category: "legal" }).key, "people.agreements");
assert.equal(presetFor({ name: "Certificate of insurance", category: "legal" }).key, "legal.insurance");
assert.equal(presetFor({ name: "Price list 2025", category: "marketing" }).key, "marketing");
// Category fallback
assert.deepEqual(presetFor({ name: "Misc", category: "financials" }), { key: "financial", byRule: false });
assert.deepEqual(presetFor({ name: "Misc", category: "legal" }), { key: "legal", byRule: false });
assert.deepEqual(presetFor({ name: "Misc", category: "operations" }), { key: "operations.reports", byRule: false });
assert.deepEqual(presetFor({ name: "Misc", category: "other" }), { key: "other", byRule: false });

// Working material never goes in (V1).
for (const sk of ["email", "call", "video_call", "crm", "website"]) {
  assert.equal(isRoomMaterial({ visibility: "shared", sourceKind: sk, category: "other", subcategory: null, fileUrl: "/uploads/docs/x.txt" }), false);
}

// Citation kinds agree with the room's folders.
const kind = (name: string, o: Record<string, unknown> = {}) => docKindFor({ name, originalName: name, category: "financials", ...o });
assert.equal(kind("T2 corporate income tax return 2023"), "tax_return");
assert.equal(kind("Financial statements FY2023"), "financial_statements");
assert.equal(kind("Customer revenue by year"), "revenue_report");
assert.equal(kind("Warehouse lease"), "lease");
assert.equal(kind("Minute book excerpt", { category: "legal" }), "corporate_record");
assert.equal(kind("Fleet list", { category: "operations" }), "asset_list");
assert.equal(kind("General ledger 2024", { originalName: "gl.xlsx" }), "general_ledger");
assert.equal(kind("2024 T4 summary", { subcategory: "addback_support" }), "payroll_report");
assert.equal(kind("Invoice — truck repair", { subcategory: "addback_support" }), "invoice");
assert.equal(kind("AR aging"), "ar_ap_report");
assert.equal(kind("Bank statement June 2024"), "bank_statement");
assert.equal(kind("Safety & CVSA compliance summary", { category: "operations" }), "licence");
assert.equal(kind("Misc", { category: "other" }), "other");

// Preset folder rows: every preset, parents before children, positions per parent.
const rows = presetFolderRows();
assert.equal(rows.length, VDR_PRESET_FOLDERS.length);
const seen = new Set<string>();
for (const r of rows) {
  if (r.parentKey) assert.ok(seen.has(r.parentKey), `${r.presetKey} after its parent`);
  seen.add(r.presetKey);
}
assert.deepEqual(rows.filter((r) => r.parentKey === null).map((r) => [r.presetKey, r.position]), [["financial", 1], ["legal", 2], ["operations", 3], ["people", 4], ["compliance", 5], ["marketing", 6], ["other", 7]]);
assert.deepEqual(rows.filter((r) => r.parentKey === "financial").map((r) => r.presetKey), ["financial.statements", "financial.tax", "financial.bank", "financial.gl", "financial.revenue", "financial.debt"]);
for (const r of rows) assert.ok(!/^\d/.test(r.name), "folder names carry no numbers (they're computed)");

// planAutoFile maps to folder ids; a missing preset falls back to Other.
const folders = [{ id: "F-tax", presetKey: "financial.tax", parentId: "F-fin" }, { id: "F-other", presetKey: "other", parentId: null }];
assert.deepEqual(planAutoFile([{ id: "d1", name: "T2 2023" }, { id: "d2", name: "Lease" }], folders), [
  { documentId: "d1", presetKey: "financial.tax", folderId: "F-tax" },
  { documentId: "d2", presetKey: "legal.property", folderId: "F-other" },
]);

console.log("vdr auto-file: ok");
