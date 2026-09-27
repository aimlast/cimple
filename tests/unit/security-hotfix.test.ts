/**
 * Security hotfix (2026-09-27): document paths stay inside the uploads docs folder, and
* request bodies can never set server-owned columns (fileUrl, dealId, brokerId, tokens…).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/security-hotfix.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { docsFileName, resolveDocumentPath } from "../../server/documents/document-path";
import {
  pickBodyFields,
  DOCUMENT_CREATE_FIELDS, DOCUMENT_PATCH_FIELDS, DOCUMENT_SERVER_OWNED,
  TASK_PATCH_FIELDS, TASK_SERVER_OWNED,
  INTEGRATION_PATCH_FIELDS, INTEGRATION_SERVER_OWNED,
} from "../../server/security/body-fields";

const ROOT = "/data/uploads";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");


// ── F-B1: the document path resolver ────────────────────────────────────
{
  // The old reprocess.ts resolution — what the finding reproduced.
  const oldResolve = (fileUrl: string) => path.join(ROOT, fileUrl.replace(/^\/uploads\//, ""));
  assert.equal(oldResolve("/uploads/../../../proc/self/environ"), "/proc/self/environ", "the old path join escaped the volume");

  // The shared resolver refuses every escape.
  for (const bad of [
    "/uploads/../../../proc/self/environ",
    "/uploads/docs/../../../proc/self/environ",
    "/uploads/docs/..%2F..%2Fetc%2Fpasswd",
    "/uploads/docs/sub/doc_1.pdf",
    "/uploads/docs/..",
    "/uploads/docs/",
    "/uploads/logo.png",
    "/proc/self/environ",
    "/uploads/docs/a\\..\\..\\x",
    "/uploads/docs/doc_1.pdf\0.txt",
    "",
  ]) {
    assert.equal(resolveDocumentPath({ fileUrl: bad }, ROOT), null, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(resolveDocumentPath({ fileUrl: null }, ROOT), null);
  // Real rows resolve inside the docs folder.
  assert.equal(resolveDocumentPath({ fileUrl: "/uploads/docs/doc_1727301234567.pdf" }, ROOT), "/data/uploads/docs/doc_1727301234567.pdf");
  assert.equal(resolveDocumentPath({ fileUrl: "/uploads/docs/source_Discovery-call_1727.txt" }, ROOT), "/data/uploads/docs/source_Discovery-call_1727.txt");
  assert.equal(docsFileName("/uploads/docs/doc_1.xlsx"), "doc_1.xlsx");

  // Every reader uses it: no hand-rolled uploads path join left in re-read,
  // ingest or cleanup.
  for (const file of ["server/documents/reprocess.ts", "server/documents/ingest.ts", "server/documents/cleanup.ts"]) {
    const src = fs.readFileSync(path.join(REPO, file), "utf8");
    assert.ok(src.includes("resolveDocumentPath"), `${file} uses the shared resolver`);
    assert.ok(!/replace\(\/\^\\\/uploads\\\/\//.test(src), `${file} has no hand-rolled /uploads/ strip`);
  }
}

// ── F-B1 / F-B5: server-owned fields can't come from a request body ─────
{
  const docPatch = (body: unknown) => pickBodyFields(body, DOCUMENT_PATCH_FIELDS, DOCUMENT_SERVER_OWNED);
  for (const key of ["fileUrl", "mimeType", "extractedText", "extractedData", "status", "dealId", "visibility", "sourceKind", "uploadedBy"]) {
    const r = docPatch({ name: "x", [key]: "anything" });
    assert.equal(r.ok, false, `document PATCH refuses ${key}`);
    if (!r.ok) assert.equal(r.field, key);
  }
  const ok = docPatch({ name: "Lease.pdf", category: "legal", subcategory: "lease", junk: 1 });
  assert.deepEqual(ok, { ok: true, data: { name: "Lease.pdf", category: "legal", subcategory: "lease" } });

  const docCreate = pickBodyFields(
    { name: "x", originalName: "x", category: "other", fileUrl: "/uploads/../../../proc/self/environ", mimeType: "text/plain" },
    DOCUMENT_CREATE_FIELDS, DOCUMENT_SERVER_OWNED,
  );
  assert.equal(docCreate.ok, false, "the finding's exact create body is refused");

  const task = pickBodyFields({ dealId: "victim-deal" }, TASK_PATCH_FIELDS, TASK_SERVER_OWNED);
  assert.equal(task.ok, false, "task PATCH refuses dealId");
  assert.deepEqual(pickBodyFields({ status: "completed", title: "t" }, TASK_PATCH_FIELDS, TASK_SERVER_OWNED), { ok: true, data: { status: "completed", title: "t" } });

  for (const key of ["brokerId", "accessToken", "refreshToken", "provider"]) {
    const r = pickBodyFields({ [key]: "x" }, INTEGRATION_PATCH_FIELDS, INTEGRATION_SERVER_OWNED);
    assert.equal(r.ok, false, `integration PATCH refuses ${key}`);
  }
  assert.deepEqual(pickBodyFields({ config: { a: 1 } }, INTEGRATION_PATCH_FIELDS, INTEGRATION_SERVER_OWNED), { ok: true, data: { config: { a: 1 } } });
  assert.deepEqual(pickBodyFields(null, INTEGRATION_PATCH_FIELDS, INTEGRATION_SERVER_OWNED), { ok: true, data: {} });
}

console.log("security hotfix: ok");
