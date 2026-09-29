/**
 * Security hotfix (2026-09-29): every /uploads request is classified on the
 * decoded, normalised path, so no spelling of docs/ skips the access check.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/uploads-gate.test.ts
 */
import assert from "node:assert/strict";
import { classifyUploadsPath, mayOpenDocument } from "../../server/security/uploads-gate";
import { newDocumentFileName } from "../../server/documents/document-path";

// Every spelling that the old mount-based check let through is now a document (checked) or blocked.
for (const p of ["/docs/doc_1.pdf", "//docs/doc_1.pdf", "/%64ocs/doc_1.pdf", "/docs%2Fdoc_1.pdf", "/./docs/doc_1.pdf", "/x/../docs/doc_1.pdf", "/DOCS/doc_1.pdf", "/Docs/doc_1.pdf", "/docs//doc_1.pdf", "/%2e/docs/doc_1.pdf", "/docs%5cdoc_1.pdf"]) {
  const r = classifyUploadsPath(p);
  assert.ok(r.kind === "document" || r.kind === "blocked", `${p} must be checked or blocked, got ${r.kind}`);
}
assert.deepEqual(classifyUploadsPath("//docs/doc_1.pdf"), { kind: "document", name: "doc_1.pdf" });
for (const p of ["/private-media/x.jpg", "//private-media/x.jpg", "/%70rivate-media/x.jpg", "/tmp-past-cim/a.pdf", "/docs/a/b.pdf", "/docs", "/docſ/doc_1.pdf", "/%zz"]) {
  assert.equal(classifyUploadsPath(p).kind, "blocked", p);
}
assert.equal(classifyUploadsPath("/logo-123.png").kind, "public");
assert.equal(classifyUploadsPath("/brand/logo.png").kind, "public");

// Who may open a document.
const deps = {
  getDocumentsByFileUrl: async () => [],
  getDeal: async (id: string) => (id === "d1" ? { id: "d1", brokerId: "b1" } : undefined),
  getSellerInviteByToken: async (t: string) => (t === "tok" ? { dealId: "d1" } : undefined),
};
(async () => {
  assert.equal(await mayOpenDocument(deps, { dealId: "d1" }, { brokerId: "b1" }), true, "owning broker");
  assert.equal(await mayOpenDocument(deps, { dealId: "d1" }, { brokerId: "b2" }), false, "other broker");
  assert.equal(await mayOpenDocument(deps, { dealId: "d1" }, { sellerToken: "tok" }), true, "seller token");
  assert.equal(await mayOpenDocument(deps, { dealId: "d1", visibility: "broker_only" }, { sellerToken: "tok" }), false, "broker-only never to the seller");
  assert.equal(await mayOpenDocument(deps, { dealId: "d1" }, {}), false, "no login");
  assert.equal(await mayOpenDocument(deps, { dealId: "gone" }, { sellerToken: "tok" }), false, "deleted deal");
  // New file names are unguessable.
  const a = newDocumentFileName("doc", ".PDF"), b = newDocumentFileName("doc", ".pdf");
  assert.match(a, /^doc_[0-9a-f]{32}\.pdf$/); assert.notEqual(a, b);
  assert.match(newDocumentFileName("src", ".txt", "Discovery call"), /^src_[0-9a-f]{32}_Discovery-call\.txt$/);
  console.log("uploads gate: ok");
})();
