// F2-DI-8 + F2-DI-9: a CRM seller import cut off by a restart left a row for
// a changed item that nothing recorded; the next import created another and
// retired only the old one, so a "Couldn't read" duplicate stayed forever.
// Now every other row for the item goes, and every retired source's file is
// removed from the uploads volume (it used to stay there).
// Starts the local fake Pipedrive itself. No model call (a fake extraction client).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/crm/f2-import-strays.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 5100 + Math.floor(Math.random() * 800);
process.env.PIPEDRIVE_API_BASE = `http://localhost:${PORT}`;
const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "f2-strays-"));
process.env.UPLOADS_DIR = uploads;
fs.mkdirSync(path.join(uploads, "docs"));

const fake = spawn(process.execPath, [path.join(process.cwd(), "scripts/fake-pipedrive.mjs"), String(PORT)], { stdio: "ignore" });
const stop = () => { try { fake.kill(); } catch { /* gone */ } };
process.on("exit", stop);

const { storage } = await import("../../server/storage");
const { startCrmImport, isImportRunning } = await import("../../server/crm/seller-import");
const { _setExtractionClientForTests, _setExtractionRetryDelaysForTests } = await import("../../server/documents/extractor");

for (let i = 0; i < 50; i++) {
  try { await fetch(`http://localhost:${PORT}/__admin/log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

_setExtractionRetryDelaysForTests([1, 1, 1]);
_setExtractionClientForTests({
  messages: {
    stream() {
      return { finalMessage: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", input: { summary: "A CRM note." } }] }) };
    },
  },
} as any);

const DEAL = "D";
const linkedAt = "2026-09-01T00:00:00.000Z";
let deal: any = {
  id: DEAL, brokerId: "b", businessName: "Maple Ridge Physio", industry: "Physiotherapy", askingPrice: null, extractedInfo: {},
  sellerContact: { source: "broker", updatedAt: linkedAt },
  crmLink: {
    provider: "pipedrive", linkedType: "deal", dealId: "501", orgId: "601", personId: "701", title: "Maple Ridge Physio", linkedAt,
    // The last import recorded the OLD version of note 9001 — the interrupted one never got recorded.
    imported: { "note:9001": { documentId: "OLD", version: "old-version" } },
  },
};
const fileFor = (id: string) => {
  const name = `src_${id}.txt`;
  fs.writeFileSync(path.join(uploads, "docs", name), `text of ${id}`);
  return `/uploads/docs/${name}`;
};
const pdDoc = (id: string, recordType: string, recordId: string, over: any = {}) => ({
  id, dealId: DEAL, name: id, originalName: id, category: "other", subcategory: null, sourceKind: "crm", visibility: "broker_only",
  sourceMeta: { provider: "pipedrive", recordType, recordId }, extractedText: `text of ${id}`, extractedData: { summary: "x" },
  fileUrl: fileFor(id), mimeType: "text/plain", status: "completed", isProcessed: true, uploadedBy: "broker",
  createdAt: new Date(1), updatedAt: new Date(1), ...over,
});
let docs: any[] = [
  pdDoc("OLD", "note", "9001"),
  pdDoc("STRAY", "note", "9001", { status: "failed", extractedData: null, isProcessed: false }), // the interrupted read
  // Everything else already imported (unchanged → skipped).
  ...["9002", "9003", "9004", "9005"].map((n) => pdDoc(`N${n}`, "note", n)),
  ...["8001", "8002", "8003"].map((n) => pdDoc(`A${n}`, "activity", n)),
  ...["7001", "7002"].map((n) => pdDoc(`M${n}`, "mail", n)),
  ...["4001", "4002", "4003"].map((n) => pdDoc(`F${n}`, "file", n)),
  pdDoc("RD", "deal", "501"), pdDoc("RO", "organization", "601"), pdDoc("RP", "person", "701"),
];
let created = 0;
const s = storage as any;
s.getDeal = async () => JSON.parse(JSON.stringify(deal));
s.updateDeal = async (_id: string, patch: any) => { deal = { ...deal, ...JSON.parse(JSON.stringify(patch)) }; return deal; };
s.getDocumentsByDeal = async () => docs.map((d) => ({ ...d }));
s.getDocument = async (id: string) => { const d = docs.find((x) => x.id === id); return d ? { ...d } : undefined; };
s.getDocumentByFileUrl = async (u: string) => docs.find((d) => d.fileUrl === u);
s.createDocument = async (data: any) => { const d = { id: `NEW${++created}`, createdAt: new Date(), updatedAt: new Date(), isProcessed: false, extractedText: null, extractedData: null, ...data }; docs.push(d); return { ...d }; };
s.updateDocument = async (id: string, patch: any) => { const d = docs.find((x) => x.id === id); if (!d) return undefined; Object.assign(d, patch, { updatedAt: new Date() }); return { ...d }; };
s.deleteDocument = async (id: string) => { docs = docs.filter((d) => d.id !== id); };
s.getDiscrepanciesByDeal = async () => [];
s.createDiscrepancy = async (d: any) => d;
s.updateDiscrepancy = async () => undefined;
s.getDocumentRequirementsByDeal = async () => [];
s.updateDocumentRequirement = async () => undefined;

// Change note 9001 in the CRM (so the item is re-imported).
await fetch(`http://localhost:${PORT}/__admin/edit-note/9001`, { method: "POST" });

await startCrmImport(DEAL, process.env.FAKE_PIPEDRIVE_TOKEN || "fake-crm-seller-token");
for (let i = 0; i < 300 && isImportRunning(DEAL); i++) await new Promise((r) => setTimeout(r, 50));
assert.equal(isImportRunning(DEAL), false, "the import finished");

const forNote = docs.filter((d) => d.sourceMeta?.recordType === "note" && d.sourceMeta?.recordId === "9001");
assert.equal(forNote.length, 1, `one source for the CRM note (got ${forNote.map((d) => d.id).join(", ")})`);
assert.ok(forNote[0].id.startsWith("NEW"), "the new version is the one kept");
assert.equal(deal.crmLink.imported["note:9001"].documentId, forNote[0].id);
assert.ok(!fs.existsSync(path.join(uploads, "docs", "src_OLD.txt")), "the replaced version's file is removed");
assert.ok(!fs.existsSync(path.join(uploads, "docs", "src_STRAY.txt")), "the interrupted read's file is removed");
assert.ok(fs.existsSync(path.join(uploads, "docs", "src_N9002.txt")), "unchanged sources keep their files");
assert.equal(docs.filter((d) => d.id.startsWith("N9") || d.id.startsWith("A") || d.id.startsWith("M") || d.id.startsWith("F")).length, 12, "unchanged sources stay");
console.log("✓ a changed CRM item replaces its old source AND the row an interrupted import left; both files leave the volume");

_setExtractionClientForTests(null);
stop();
fs.rmSync(uploads, { recursive: true, force: true });
console.log("f2-import-strays: all passed");
process.exit(0);
