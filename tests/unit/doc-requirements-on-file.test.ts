// Release review DEP-3: industry document requests added to an existing deal
// (the ship-time backfill, and every interview opening via
// ensureIndustryDocumentRequirements) started as "missing" even when the deal
// already held that document — so sellers were asked for files they had
// given. A new request now starts received, credited to the document on
// file, by the same name rule as an upload. The file names are the demo
// deals' own (read-only dry run on production, 2026-09-29).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/doc-requirements-on-file.test.ts
import assert from "node:assert/strict";

const { storage } = await import("../../server/storage");
const {
  planDocumentRequirements,
  populateDocumentRequirements,
  ensureIndustryDocumentRequirements,
  findMatchingRequirement,
} = await import("../../server/documents/requirements");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const doc = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, category: "operations", sourceKind: "document", visibility: "shared", status: "extracted", uploadedBy: "seller",
  createdAt: new Date("2026-09-20T10:00:00Z"), ...over,
});
// Pacific already credited its fleet list to the universal equipment row.
const pacificRows = [{ documentName: "Asset and Equipment List", uploadedFileId: "d-fleet" }];
const pacificDocs = [
  doc("d-fleet", "Fleet list — power units, trailers, equipment (Dec 31, 2024)"),
  doc("d-fs", "Compiled financial statements FY2024", { category: "financials" }),
];

console.log("planning");
await test("a request for a document the deal holds is planned as received (even when that file already answers another row)", () => {
  const plan = planDocumentRequirements(pacificRows, pacificDocs, "Transportation & Logistics");
  const fleet = plan.find((p) => p.doc.documentName === "Fleet List with Age and Condition")!;
  assert.equal(fleet.heldBy?.id, "d-fleet");
  const other = plan.filter((p) => p.doc.documentName !== "Fleet List with Age and Condition");
  assert.ok(other.length > 0 && other.every((p) => !p.heldBy || p.heldBy.id !== "d-fs" || /financial/i.test(p.doc.documentName)));
  assert.ok(!plan.some((p) => p.doc.documentName === "Asset and Equipment List"), "rows already on the deal are never re-added");
});
await test("uploaded but uncategorised files count; broker-only, failed and non-document sources never do", () => {
  const rows: Array<{ documentName: string }> = [];
  const base = planDocumentRequirements(rows, [doc("d1", "commercial-lease-agreement.pdf", { category: "other" })], "Construction");
  assert.equal(base.find((p) => p.doc.documentName === "Commercial Lease Agreement")?.heldBy?.id, "d1");
  for (const over of [{ visibility: "broker_only" }, { status: "failed" }, { sourceKind: "email" }, { sourceKind: "crm" }]) {
    const plan = planDocumentRequirements(rows, [doc("d1", "commercial-lease-agreement.pdf", { category: "other", ...over })], "Construction");
    assert.equal(plan.find((p) => p.doc.documentName === "Commercial Lease Agreement")?.heldBy, undefined, JSON.stringify(over));
  }
});
await test("the matcher's false positives found on production stay missing", () => {
  const rows: Array<{ documentName: string }> = [];
  // "with" was a shared keyword.
  const hvac = planDocumentRequirements(rows, [doc("d1", "Staff roster with technician licences")], "HVAC / Home Services");
  assert.equal(hvac.find((p) => p.doc.documentName === "Equipment List with Ownership Status")?.heldBy, undefined);
  // The kind of business is not a document.
  const it = planDocumentRequirements(rows, [doc("d2", "Ashworth Practice Overview.txt", { category: "other" })], "IT / Managed Services");
  assert.equal(it.find((p) => p.doc.documentName === "Practice Management Software Records")?.heldBy, undefined);
  // A printed e-mail about a valuation is not an inventory valuation.
  assert.equal(
    findMatchingRequirement([{ id: "r", documentName: "Inventory Valuation (Current)", category: "financial", status: "missing" }],
      "A R Business Brokers Mail - Re_ sariKNOTsari Initial Valuation Questions.pdf", "other"),
    undefined,
  );
});

console.log("writing (the live path and the backfill share populateDocumentRequirements)");
const created: any[] = [];
const s = storage as any;
s.getDocumentRequirementsByDeal = async () => pacificRows;
s.getDocumentsByDeal = async () => pacificDocs;
s.createDocumentRequirement = async (d: any) => { created.push(d); return { id: `r${created.length}`, ...d }; };
await test("populateDocumentRequirements writes the held request as uploaded, credited to the file", async () => {
  const n = await populateDocumentRequirements("deal-pacific", "Transportation & Logistics");
  assert.ok(n > 0);
  const fleet = created.find((c) => c.documentName === "Fleet List with Age and Condition");
  assert.equal(fleet.status, "uploaded");
  assert.equal(fleet.uploadedFileId, "d-fleet");
  assert.equal(fleet.uploadedBy, "seller");
  assert.ok(fleet.uploadedAt instanceof Date);
  const missing = created.filter((c) => c.status === "missing");
  assert.ok(missing.length > 0 && missing.every((c) => !c.uploadedFileId));
});
await test("an interview opening (ensureIndustryDocumentRequirements) takes the same path", async () => {
  created.length = 0;
  await ensureIndustryDocumentRequirements("deal-pacific-2", "Transportation & Logistics");
  assert.equal(created.find((c) => c.documentName === "Fleet List with Age and Condition")?.status, "uploaded");
});

console.log(`\n${passed} passed`);
