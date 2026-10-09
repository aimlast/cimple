/**
 * vdr spec §4.6 / V2: nothing is shared until the broker confirms the
 * recommended plan; flagged documents wait for a tick; a new file in a
 * shared folder asks "Share it like the rest?" and is NEVER shared on its own.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-plan.test.ts
 */
import assert from "node:assert/strict";
import { recommendedPlan, planShareRows, newInHintedFolder } from "../../server/vdr/auto-file";
import type { VdrFlag } from "../../shared/vdr";

const folders = [
  { id: "fin", presetKey: "financial", parentId: null, name: "Financial" },
  { id: "stat", presetKey: "financial.statements", parentId: "fin", name: "Financial statements" },
  { id: "tax", presetKey: "financial.tax", parentId: "fin", name: "Tax returns" },
  { id: "bank", presetKey: "financial.bank", parentId: "fin", name: "Bank statements" },
  { id: "gl", presetKey: "financial.gl", parentId: "fin", name: "General ledger & add-back support" },
  { id: "staff", presetKey: "people.staff", parentId: "people", name: "Staff & organisation" },
  { id: "people", presetKey: "people", parentId: null, name: "People" },
  { id: "lease", presetKey: "legal.property", parentId: "legal", name: "Leases & property" },
  { id: "mine", presetKey: null, parentId: "tax", name: "Schedules (broker's own)" },
  { id: "empty", presetKey: "compliance", parentId: null, name: "Licences, permits & compliance" },
];
const items = [
  { id: "s22", folderId: "stat", title: "Statements 2022" },
  { id: "s23", folderId: "stat", title: "Statements 2023 (black box)" },
  { id: "t23", folderId: "tax", title: "T2 2023 (form field)" },
  { id: "t24", folderId: "tax", title: "T2 2024" },
  { id: "b24", folderId: "bank", title: "Bank 2024" },
  { id: "ledger", folderId: "gl", title: "General ledger 2024", isLedger: true },
  { id: "roster", folderId: "staff", title: "Driver roster" },
  { id: "l1", folderId: "lease", title: "Warehouse lease" },
  { id: "sch", folderId: "mine", title: "Schedule 50" },
  { id: "dead", folderId: "tax", title: "Old", removedAt: new Date() },
];
const look = (key: VdrFlag["key"]): VdrFlag => ({ key, look: true, copy: key });
const flags = new Map<string, VdrFlag[]>([
  ["s23", [look("hidden_words")]],
  ["t23", [{ key: "form_fields", look: false, copy: "note" }, look("scanned")]],
  ["roster", [look("staff_records")]],
  ["ledger", [look("staff_records")]],
  ["t24", [{ key: "personal_covered", look: false, copy: "note only" }]],
]);

const plan = recommendedPlan(folders, items, flags);
const levels = Object.fromEntries(plan.folders.map((f) => [f.folderId, f.levels]));
assert.deepEqual(levels.stat, ["due_diligence"]);
assert.deepEqual(levels.tax, ["due_diligence"]);
assert.deepEqual(levels.bank, [], "bank statements: Not yet");
assert.deepEqual(levels.gl, [], "the general ledger: Not yet (DD only, gl)");
assert.deepEqual(levels.staff, [], "people: Not yet");
assert.deepEqual(levels.lease, ["due_diligence"]);
assert.deepEqual(levels.mine, ["due_diligence"], "a broker's own folder inherits its preset parent's recommendation");
assert.equal(levels.empty, undefined, "folders without documents get no row");
assert.equal(plan.folders.find((f) => f.folderId === "tax")!.count, 2, "tombstones don't count");
assert.deepEqual(plan.flagged.map((f) => f.itemId).sort(), ["ledger", "roster", "s23", "t23"], "notes (personal numbers covered, form fields) never block");

// Confirm the plan WITHOUT ticking anything: only unflagged documents in DD folders are shared.
const flagged = new Set(plan.flagged.map((f) => f.itemId));
const choice = plan.folders.map((f) => ({ folderId: f.folderId, levels: f.levels }));
const rows = planShareRows(choice, items, flagged, new Set());
assert.deepEqual(rows.map((r) => r.itemId).sort(), ["l1", "s22", "sch", "t24"]);
assert.ok(rows.every((r) => r.accessLevel === "due_diligence"));
// Ticking one flagged document includes it.
assert.deepEqual(planShareRows(choice, items, flagged, new Set(["s23"])).map((r) => r.itemId).sort(), ["l1", "s22", "s23", "sch", "t24"]);
// Legacy level keys are normalised when stored (C2), unknown levels and blind/teaser levels are dropped.
const legacy = planShareRows([{ folderId: "stat", levels: ["loi", "teaser", "blind", "nonsense"] }], items, flagged, new Set());
assert.deepEqual(legacy, [{ itemId: "s22", accessLevel: "named" }]);
// A ledger only ever gets the due-diligence level, even when its folder is set to Full CIM too.
const led = planShareRows([{ folderId: "gl", levels: ["named", "due_diligence"] }], items, new Set(), new Set());
assert.deepEqual(led, [{ itemId: "ledger", accessLevel: "due_diligence" }]);

// "New in 1.2 Tax returns: 'T2 2025'. Share it like the rest?" — a to-do, never a share.
const hinted = [{ id: "tax", shareHint: { levels: ["due_diligence"] } }, { id: "stat", shareHint: null }];
const taxItems = [
  { id: "t23", folderId: "tax" },
  { id: "t24", folderId: "tax" },
  { id: "t25", folderId: "tax" }, // the new one
];
const shares = [
  { itemId: "t23", audience: "level", accessLevel: "due_diligence", effect: "allow" },
  { itemId: "t24", audience: "level", accessLevel: "due_diligence", effect: "allow" },
];
assert.deepEqual(newInHintedFolder(hinted, taxItems, shares), [{ itemId: "t25", folderId: "tax", levels: ["due_diligence"] }]);
// Not when the others are shared differently, or the folder had no plan.
assert.deepEqual(newInHintedFolder(hinted, taxItems, [shares[0], { itemId: "t24", audience: "level", accessLevel: "named", effect: "allow" }]), []);
assert.deepEqual(newInHintedFolder([{ id: "tax", shareHint: null }], taxItems, shares), []);
assert.deepEqual(newInHintedFolder(hinted, taxItems.slice(0, 2), shares), [], "nothing new");

console.log("vdr plan: ok");
