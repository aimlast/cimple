/**
 * Release review UX-F14: the Lakeshore seller's checklist showed "Tax Returns
 * (3 Years) — Email - RE: Document request (Tony sends statements, T2s,
 * lease)" and "Bank Statements (3 Months) — Compiled financial statements
 * FY2023": credits older code wrote. wrongChecklistCredits finds them (an
 * e-mail is never a checklist document; a name the row never matches), and
 * the repair credits the document that IS the row when the deal holds it.
 * Pure (no DB, no AI).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/checklist-credit-repair.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findMatchingRequirement, wrongChecklistCredits } from "../../server/documents/requirements";

const at = new Date("2026-09-20T00:00:00Z");
const doc = (id: string, name: string, category: string, sourceKind = "document", extra: Record<string, unknown> = {}) => ({ id, name, category, sourceKind, status: "processed", uploadedBy: "broker", createdAt: at, visibility: "shared", ...extra });
const row = (id: string, documentName: string, category: string, uploadedFileId: string | null) => ({ id, documentName, category, status: uploadedFileId ? "uploaded" : "missing", uploadedFileId, source: "auto" });

const docs = [
  doc("fs22", "Compiled financial statements FY2022", "financials"),
  doc("fs23", "Compiled financial statements FY2023", "financials"),
  doc("mail", "Email - RE: Document request (Tony sends statements, T2s, lease)", "other", "email"),
  doc("lease", "Shop lease - 240 Bayfront Commerce Drive (2018-2028)", "legal"),
  doc("t2", "T2 corporate income tax return 2023", "financials"),
  doc("memo", "Valuation memo", "financials", "document", { visibility: "broker_only" }),
];
const rows = [
  row("r-fs", "Financial Statements (3 Years)", "financial", "fs22"),
  row("r-bank", "Bank Statements (3 Months)", "financial", "fs23"),
  row("r-tax", "Tax Returns (3 Years)", "tax", "mail"),
  row("r-lease", "Commercial Lease Agreement", "legal", "lease"),
  row("r-gl", "General Ledger (3 Years, Excel or CSV)", "financial", "fs22"),
];
(rows[4] as any).source = "gl_tracing";

// The current matcher would never make either credit (proof the data is old, not the rule).
assert.equal(findMatchingRequirement([{ ...rows[1], status: "missing" }], docs[1].name, "financials"), undefined, "statements are not bank statements");
assert.equal(findMatchingRequirement([{ ...rows[2], status: "missing" }], docs[2].name, "other"), undefined, "an e-mail is not the tax returns");

const found = wrongChecklistCredits(rows, docs);
assert.deepEqual(found.map((w) => [w.row.id, w.reason]), [["r-bank", "name_mismatch"], ["r-tax", "not_a_document"]], "only the two wrong credits; the GL row is never touched");
const tax = found.find((w) => w.row.id === "r-tax")!;
assert.equal(tax.replacement?.id, "t2", "the tax return on file takes the row");
assert.equal(found.find((w) => w.row.id === "r-bank")!.replacement, null, "kept unless asked (a broker may have linked it by hand)");
const both = wrongChecklistCredits(rows, docs, { includeNameMismatch: true });
const bank = both.find((w) => w.row.id === "r-bank")!;
assert.equal(bank.replacement, null, "no bank statements on file → missing (never a broker-only file, never a file another row keeps)");
// A broker-only document never becomes a checklist credit.
const onlyMemo = wrongChecklistCredits([row("r-x", "Valuation", "financial", "mail")], [docs[2], docs[5]]);
assert.equal(onlyMemo[0].replacement, null);

const script = readFileSync(new URL("../../scripts/repair-checklist-credits.ts", import.meta.url), "utf8");
assert.ok(/nameMismatch = args\.includeNameMismatch && \(!!deal\.demoKey \|\| args\.allowReal\)/.test(script), "name mismatches only on demo deals unless --allow-real");
assert.ok(script.includes("if (!args.apply) continue;"), "dry run by default");
console.log("checklist-credit-repair: ok");
