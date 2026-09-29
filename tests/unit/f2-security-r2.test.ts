/**
 * Second free round, stream "security", round 2 — the checker's open items.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f2-security-r2.test.ts
 *
 * S3   the signature and the NDA answers are written in the one atomic claim
 *      (ndaAccessFields); marking a criteria read merges into nda_profile in
 *      the database, never rewrites it
 * S1   any non-ASCII /uploads path is refused ("docſ" folds to "docs" on APFS)
 * S4   the orphan clean-up deletes exactly the rows its dry run counts
 *      (never a row with no deal id); a superseded CRM source's file goes
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const UP = fs.mkdtempSync(path.join(os.tmpdir(), "f2sec-r2-"));
process.env.UPLOADS_DIR = UP;
process.env.ANTHROPIC_API_KEY = "disabled";

const { PgDialect } = await import("drizzle-orm/pg-core");
const { sql } = await import("drizzle-orm");
const { classifyUploadsPath } = await import("../../server/security/uploads-gate");
const { orphanedRowsWhere } = await import("../../server/deals/delete-deal");
const { ndaAccessFields, ndaCriteriaReadOf } = await import("../../server/buyers/nda-profile");
const { storage, DbStorage } = await import("../../server/storage");
const { db } = await import("../../server/db");
const { retireDocument } = await import("../../server/crm/seller-import");

let passed = 0;
const failed: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failed.push(name);
    console.log(`FAIL ${name}: ${String(err?.message ?? err).split("\n")[0]}`);
  }
}
const dialect = new PgDialect();

// ── S1 ────────────────────────────────────────────────────────────────
await test("S1: non-ASCII folder spellings are refused (APFS folds ſ to s)", () => {
  for (const p of ["/doc%C5%BF/doc_1.pdf", "/DOC%C5%BF/doc_1.pdf", "/tmp-pa%C5%BFt-cim/a.part", "/priv%C4%B1ate-media/d/x.jpg", "/do%EF%BD%83s/doc_1.pdf", "/docs/doc_%C3%A9.pdf", "/logo_%C3%A9.png", "/docs/doc_1.pdf%0A"]) {
    assert.equal(classifyUploadsPath(p).kind, "blocked", p);
  }
});
await test("S1: ordinary names are unchanged (documents, logos, a space)", () => {
  assert.deepEqual(classifyUploadsPath("/docs/doc_ab12.pdf"), { kind: "document", name: "doc_ab12.pdf" });
  assert.equal(classifyUploadsPath("/brand/0af3.png").kind, "public");
  assert.equal(classifyUploadsPath("/logo_1759%20copy.png").kind, "public");
});

// ── S4: the orphan filter ─────────────────────────────────────────────
await test("S4: the orphan filter skips rows with no deal id (count and --apply share it)", () => {
  const q = dialect.sqlToQuery(sql`DELETE FROM ${sql.identifier("documents")} WHERE ${orphanedRowsWhere("documents", "deal_id")}`);
  assert.match(q.sql, /"documents"\."deal_id" IS NOT NULL/);
  assert.match(q.sql, /NOT EXISTS \(SELECT 1 FROM deals x WHERE x\.id = "documents"\."deal_id"\)/);
  const script = fs.readFileSync(new URL("../../scripts/cleanup-orphaned-deal-data.ts", import.meta.url), "utf8");
  // Every statement in the script that picks orphaned rows goes through the shared filter.
  assert.equal((script.match(/NOT EXISTS/g) ?? []).length, 2, "the files query only (its own documents join)");
  assert.equal((script.match(/WHERE \$\{orphaned\}/g) ?? []).length, 3, "count, detach and delete use the same filter");
});

// ── S3: the fields of the atomic claim ────────────────────────────────
const profile: any = {
  buyerType: "individual", name: "Sam Rivera", phone: "555-0100", company: null, companyWebsite: null, title: null,
  background: "Ran a dental lab.", lookingFor: "Dental practices in Ontario", priceMin: 1000000, priceMax: 3000000,
  funding: "bank_loan", proofOfFunds: "yes", timeline: "3_6", operateSelf: "yes", fitReason: null, dealRole: null,
  checkSize: null, appealedTo: null, bestTimeToContact: null, financialKind: null,
};
const signature = { signerName: "Sam Rivera", signedAt: "2026-09-28T00:00:00.000Z", ip: null, termsHash: "h", termsText: "t", termsSource: "default" };
await test("S3: a new profile goes on the row with the signature, in one write", () => {
  const f = ndaAccessFields({ buyerCompany: "Old Co", ndaProfile: null } as any, profile, signature) as any;
  assert.equal(f.buyerName, "Sam Rivera");
  assert.equal(f.buyerCompany, "Old Co");
  assert.equal(f.proofOfFunds, true);
  assert.deepEqual(f.ndaProfile.signature, signature);
  assert.equal(f.ndaProfile.lookingFor, profile.lookingFor);
  assert.ok(f.ndaProfile.submittedAt);
});
await test("S3: confirming the profile on file keeps the row's earlier answers and adds the signature", () => {
  const f = ndaAccessFields({ buyerCompany: null, ndaProfile: { name: "Earlier", lookingFor: "x" } } as any, null, signature) as any;
  assert.deepEqual(Object.keys(f), ["ndaProfile"]);
  assert.equal(f.ndaProfile.name, "Earlier");
  assert.deepEqual(f.ndaProfile.signature, signature);
});
await test("S3: the criteria-read marker", () => {
  assert.equal(ndaCriteriaReadOf({ ndaProfile: { criteriaReadOf: "[\"a\",\"b\"]" } } as any), "[\"a\",\"b\"]");
  assert.equal(ndaCriteriaReadOf({ ndaProfile: null } as any), null);
  assert.equal(ndaCriteriaReadOf({ ndaProfile: { criteriaReadOf: 3 } } as any), null);
});
await test("S3: marking a read merges into nda_profile in the database (never rewrites the signature)", async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const realUpdate = (db as any).update;
  (db as any).update = () => ({
    set: (values: any) => ({
      where: (w: any) => {
        const set = dialect.sqlToQuery(values.ndaProfile);
        const where = dialect.sqlToQuery(w);
        seen.push({ sql: `${set.sql} WHERE ${where.sql}`, params: [...set.params, ...where.params] });
        return Promise.resolve([]);
      },
    }),
  });
  try {
    await new DbStorage().markNdaCriteriaRead("acc-1", "[\"x\",\"y\"]");
  } finally {
    (db as any).update = realUpdate;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /coalesce\("buyer_access"\."nda_profile", '\{\}'::jsonb\) \|\| jsonb_build_object\('criteriaReadOf', \$1::text\)/);
  assert.deepEqual(seen[0].params, ["[\"x\",\"y\"]", "acc-1"]);
});

// ── S4: a superseded CRM source's file ────────────────────────────────
await test("S4: retiring a superseded CRM source deletes its file (a shared file stays)", async () => {
  fs.mkdirSync(path.join(UP, "docs"), { recursive: true });
  fs.writeFileSync(path.join(UP, "docs", "crm_old.txt"), "OLD");
  fs.writeFileSync(path.join(UP, "docs", "crm_shared.txt"), "SHARED");
  const rows = new Map<string, any>([
    ["d-old", { id: "d-old", dealId: "D1", fileUrl: "/uploads/docs/crm_old.txt" }],
    ["d-sh1", { id: "d-sh1", dealId: "D1", fileUrl: "/uploads/docs/crm_shared.txt" }],
    ["d-sh2", { id: "d-sh2", dealId: "D2", fileUrl: "/uploads/docs/crm_shared.txt" }],
  ]);
  const s = storage as any;
  const saved: Record<string, unknown> = {};
  const stub = (k: string, fn: (...a: any[]) => any) => { saved[k] = s[k]; s[k] = async (...a: any[]) => fn(...a); };
  stub("getDocument", (id) => (rows.has(id) ? { ...rows.get(id) } : undefined));
  stub("deleteDocument", (id) => { rows.delete(id); });
  stub("getDocumentsByFileUrl", (u) => Array.from(rows.values()).filter((r) => r.fileUrl === u));
  stub("getDocumentsByDeal", (d) => Array.from(rows.values()).filter((r) => r.dealId === d));
  stub("getDeal", () => undefined);
  stub("getDiscrepanciesByDeal", () => []);
  stub("getDocumentRequirementsByDeal", () => []);
  try {
    await retireDocument(rows.get("d-old"));
    await retireDocument(rows.get("d-sh1"));
  } finally {
    for (const [k, v] of Object.entries(saved)) s[k] = v;
  }
  assert.equal(rows.has("d-old"), false, "the row stays");
  assert.equal(fs.existsSync(path.join(UP, "docs", "crm_old.txt")), false, "the superseded file stays on the volume");
  assert.equal(fs.existsSync(path.join(UP, "docs", "crm_shared.txt")), true, "a file another row points at was deleted");
});

fs.rmSync(UP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
