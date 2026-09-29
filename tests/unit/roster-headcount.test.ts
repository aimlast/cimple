// Head counts by role: the staff roster / licence register is the authority
// (decision A), and a seller-side count that differs is raised — across
// facts (Lakeshore rebuild 2026-09-28: the website's and the seller's "24
// licensed technicians" printed over the roster's 22; no discrepancy).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/roster-headcount.test.ts
import assert from "node:assert/strict";
import { roleCounts } from "../../server/cim/discrepancy-backstop";
import { applyRosterCounts, countDisputesOnFile, discrepancyForConflict, mergeConflictFalseReason, planMergeRowSupersession } from "../../server/documents/merge-conflicts";
import { isDocumentAuthoritativeField, materiallyDifferent, settleConflicts } from "../../server/documents/merge-policy";

// ── Reading head counts ──
const role = (t: string) => roleCounts(t).map((c) => `${c.value}:${c.role}`);
assert.deepEqual(role("24 licensed techs in the field"), ["24:licensed technician"]);
assert.deepEqual(role("24 licensed technicians"), ["24:licensed technician"]);
assert.deepEqual(role("28 total (22 licensed field technicians, 2 licensed managers, 3 registered apprentices, 1 installer/helper)"), ["22:licensed technician", "2:licensed manager", "3:registered apprentice"]);
assert.deepEqual(role("Employee ID,Name\nLicensed field technicians - total,22\n"), ["22:licensed technician"], "a roster's total row");
assert.deepEqual(role("17 licensed HVAC technicians"), ["17:licensed hvac technician"], "a narrower role is another role");
assert.deepEqual(role("about 24 licensed technicians"), [], "hedged");
assert.deepEqual(role("only 2 techs lost in the last 3 years"), [], "a subset");
assert.deepEqual(role("24 service vans"), [], "vans are not a head count");
assert.ok(isDocumentAuthoritativeField("licensedTechnicianCount") && isDocumentAuthoritativeField("licensedTechnicians") && isDocumentAuthoritativeField("driverCount"));
assert.ok(!isDocumentAuthoritativeField("keyEmployees") && !isDocumentAuthoritativeField("technicianTenure") && !isDocumentAuthoritativeField("employeeStructure"));
assert.equal(materiallyDifferent("licensedTechnicianCount", "22 licensed field technicians", "24 licensed techs in the field"), true, "a head count is exact");
assert.equal(materiallyDifferent("licensedTechnicianCount", "22 licensed field technicians", "22 licensed techs"), false);

// ── Lakeshore's facts, as stored ──
const docs = [
  { id: "lic", name: "Licensing, registration & insurance summary (TSSA, WSIB, insurance)", visibility: "shared", sourceKind: "document", extractedText: "Summary: 22 licensed field technicians (6 x 313A, 11 x 313D, 5 x 306A)" },
  { id: "roster", name: "Staff roster with technician licences", visibility: "shared", sourceKind: "document", extractedText: "Licensed field technicians - total,22\nE-104,Luis Fernandes,Senior HVAC Technician" },
  { id: "web", name: "Website text", visibility: "shared", sourceKind: "website", extractedText: "* 24 licensed technicians" },
  { id: "call", name: "Cimple video call", visibility: "shared", sourceKind: "video_call", extractedText: "" },
  { id: "crm", name: "CRM note - staff roster", visibility: "broker_only", sourceKind: "crm", extractedText: "Licensed field technicians - total,19" },
] as any[];
const lakeshore = (): Record<string, unknown> => ({
  employees: "36",
  licensedTechnicians: "24 licensed technicians",
  licensedTechnicianCount: "24 licensed techs in the field",
  technicianTenure: "Luis 16 years, Paulo 14 years, only 2 techs lost in last 3 years (one retired, one moved to Alberta, one terminated)",
  _fieldSources: {
    employees: { source: "document", documentId: "roster", specialist: true },
    licensedTechnicians: { source: "website", documentId: "web" },
    licensedTechnicianCount: { source: "video_call", documentId: "call", speaker: "Tony Moretti (seller)" },
    technicianTenure: { source: "video_call", documentId: "call" },
  },
  _fieldAlternates: {
    employees: [{ value: "28 total (22 licensed field technicians, 2 licensed managers, 3 registered apprentices, 1 installer/helper)", source: "document", documentId: "lic", brokerOnly: false }],
  },
});

{
  const info = lakeshore();
  // Before: no row for the 24 vs 22 (the model check dismissed it; the merge never compared across keys).
  const changed = applyRosterCounts(info, docs);
  assert.deepEqual(changed.sort(), ["licensedTechnicianCount", "licensedTechnicians"]);
  assert.equal(info.licensedTechnicianCount, "22 licensed field technicians", "the roster's count is on file (a video call ranks below the roster)");
  assert.equal(info.licensedTechnicians, "22 licensed field technicians", "the website's count too");
  const src = (info._fieldSources as any).licensedTechnicianCount;
  assert.equal(src.source, "document");
  assert.equal(src.specialist, true);
  const alts = (info._fieldAlternates as any).licensedTechnicianCount.map((a: any) => `${a.value}|${a.source}`);
  assert.deepEqual(alts, ["24 licensed techs in the field|video_call"], "the seller's count is kept as another value");
  assert.equal(info.technicianTenure, lakeshore().technicianTenure, "a narrative fact is never rewritten");
  assert.equal(applyRosterCounts(info, docs).length, 0, "idempotent");

  // The dispute is raised as a merge row on the seller's fact — and only on the seller's words (not the website's).
  const conflicts = settleConflicts(info, countDisputesOnFile(info, docs));
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.factKey, "licensedTechnicianCount");
  assert.equal(mergeConflictFalseReason(c, new Map(docs.map((d) => [d.id, d]))), null);
  const row = discrepancyForConflict(c, (id) => docs.find((d) => d.id === id)?.name);
  assert.equal(row.severity, "significant");
  assert.equal(row.category, "operational");
  assert.equal(row.interviewValue, "24 licensed techs in the field");
  assert.equal(row.documentValue, "22 licensed field technicians");
  assert.match(String(row.aiExplanation), /a document is the authority on this figure|the source dedicated to this/);
  // The lifecycle keeps it (both values are stated for the fact).
  const stored = [{ id: "r1", dealId: "d", createdAt: new Date(), ...row }] as any[];
  assert.deepEqual(planMergeRowSupersession(stored, info, docs), []);
}

{
  // The seller said it live in the interview: the interview outranks the roster — kept, the roster's count
  // becomes another value, and the dispute is still raised.
  const info = lakeshore();
  (info._fieldSources as any).licensedTechnicianCount = { source: "interview", sessionId: "s1", turn: 3 };
  applyRosterCounts(info, docs);
  assert.equal(info.licensedTechnicianCount, "24 licensed techs in the field");
  assert.ok((info._fieldAlternates as any).licensedTechnicianCount.some((a: any) => a.value === "22 licensed field technicians" && a.source === "document"));
  const conflicts = settleConflicts(info, countDisputesOnFile(info, docs));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].winner.value, "24 licensed techs in the field");
  assert.equal(conflicts[0].loser.value, "22 licensed field technicians");
}

{
  // Broker-only material is never the roster; a broker's own value is never replaced.
  const info = lakeshore();
  (info._fieldSources as any).licensedTechnicianCount = { source: "broker" };
  applyRosterCounts(info, docs.filter((d) => d.id !== "lic" && d.id !== "roster").concat([]));
  assert.equal(info.licensedTechnicianCount, "24 licensed techs in the field");
  const b = lakeshore();
  (b._fieldSources as any).licensedTechnicianCount = { source: "broker" };
  applyRosterCounts(b, docs);
  assert.equal(b.licensedTechnicianCount, "24 licensed techs in the field", "the broker's figure stands");
}

{
  // Two rosters that disagree: nothing is preferred.
  const info = lakeshore();
  const two = [...docs, { id: "roster2", name: "Payroll register Q1", visibility: "shared", sourceKind: "document", extractedText: "Licensed field technicians - total,23" }];
  assert.deepEqual(applyRosterCounts(info, two), []);
}

console.log("roster-headcount: all passed");
