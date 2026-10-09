/**
 * Second free round, stream "security" — the pure / fake-backed pieces.
 * (The HTTP behaviour is in tests/security/f2-security-routes.test.ts.)
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f2-security.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../shared/schema";
import { classifyUploadsPath, mayOpenDocument } from "../../server/security/uploads-gate";
import { docsFileName, newDocumentFileName, resolveDocumentPath } from "../../server/documents/document-path";
import { DEAL_CHILD_TABLES, deleteDealRows, dealFilesToRemove } from "../../server/deals/delete-deal";
import { createPerKeyLimiter } from "../../server/security/per-key-limit";
import { applyBulkRateLimits, mapWithConcurrency, BULK_OUTREACH_MAX } from "../../server/security/bulk-limits";
import { approvedForSharing, MAX_BUYER_QUESTION_CHARS } from "../../shared/buyer-qa-scope";
import { otherBrokerSessionsSignOut, regenerateSession, signOutOtherBrokerSessions } from "../../server/broker-auth/sessions";
import { greetingNameFor } from "../../server/buyer-auth/routes";
import { extractionInputFromProfile, extractionInputOf } from "../../server/buyers/nda-profile";

let passed = 0;
const failed: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed.push(name);
    console.error(`  ✗ ${name}`, err);
  }
}
const dialect = new PgDialect();

// ── S1 ────────────────────────────────────────────────────────────────
await test("S1: every spelling of the docs folder is classified as a document", () => {
  const doc = { kind: "document", name: "doc_1.pdf" };
  for (const p of [
    "/docs/doc_1.pdf", "//docs/doc_1.pdf", "/%64ocs/doc_1.pdf", "/docs%2Fdoc_1.pdf", "/docs%2fdoc_1.pdf",
    "/./docs/doc_1.pdf", "/%2e/docs/doc_1.pdf", "/x/../docs/doc_1.pdf", "/x/%2e%2e/docs/doc_1.pdf",
    "/DOCS/doc_1.pdf", "/Docs/doc_1.pdf", "/docs/./doc_1.pdf", "/docs//doc_1.pdf", "\\docs\\doc_1.pdf", "/docs%5Cdoc_1.pdf",
  ]) {
    assert.deepEqual(classifyUploadsPath(p), doc, p);
  }
});
await test("S1: sub-folders, the folder itself, traversal out and bad encodings are blocked", () => {
  for (const p of ["/docs", "/docs/", "/docs/sub/doc_1.pdf", "/%E0%A4%A", "/docs/doc_1.pdf%00.txt", "/private-media/d/x.jpg", "/%70rivate-media/d/x.jpg", "/tmp-past-cim/a.part", "/TMP-PAST-CIM/a.part"]) {
    assert.equal(classifyUploadsPath(p).kind, "blocked", p);
  }
});
await test("S1: branding files stay public", () => {
  assert.equal(classifyUploadsPath("/logo_123.png").kind, "public");
  assert.equal(classifyUploadsPath("/brand/abc.png").kind, "public");
  assert.equal(classifyUploadsPath("/documents-guide.pdf").kind, "public", "a name merely starting with docs- is not the folder");
});
await test("S1: document access — owner broker, seller token (not broker-only), never an orphan", async () => {
  const deps = {
    getDocumentsByFileUrl: async () => [],
    getDeal: async (id: string) => (id === "D1" ? { id: "D1", brokerId: "b1" } : undefined),
    getSellerInviteByToken: async (t: string) => (t === "tok" ? { dealId: "D1" } : t === "orphan" ? { dealId: "GONE" } : undefined),
  };
  assert.equal(await mayOpenDocument(deps, { dealId: "D1" }, { brokerId: "b1" }), true);
  assert.equal(await mayOpenDocument(deps, { dealId: "D1" }, { brokerId: "b2" }), false);
  assert.equal(await mayOpenDocument(deps, { dealId: "D1" }, { sellerToken: "tok" }), true);
  assert.equal(await mayOpenDocument(deps, { dealId: "D1", visibility: "broker_only" }, { sellerToken: "tok" }), false);
  assert.equal(await mayOpenDocument(deps, { dealId: "D1", visibility: "broker_only" }, { brokerId: "b1" }), true);
  assert.equal(await mayOpenDocument(deps, { dealId: "GONE" }, { sellerToken: "orphan" }), false);
});
await test("S1: new upload names are unguessable and valid docs names", () => {
  const names = new Set<string>();
  for (let i = 0; i < 200; i++) names.add(newDocumentFileName("doc", ".PDF"));
  assert.equal(names.size, 200);
  const n = newDocumentFileName("doc", ".pdf");
  assert.match(n, /^doc_[0-9a-f]{32}\.pdf$/);
  assert.equal(docsFileName(`/uploads/docs/${n}`), n);
  assert.match(newDocumentFileName("src", ".txt", "Discovery call — Mar 3"), /^src_[0-9a-f]{32}_Discovery-call-Mar-3\.txt$/);
  assert.match(newDocumentFileName("crm", ".p%2f"), /^crm_[0-9a-f]{32}$/, "an odd extension is dropped");
  assert.ok(resolveDocumentPath({ fileUrl: `/uploads/docs/${newDocumentFileName("crm", ".xlsx")}` }, "/data/uploads"));
});

// ── S2 ────────────────────────────────────────────────────────────────
await test("S2: only a seller-approved or broker-adopted row is shareable", () => {
  assert.equal(approvedForSharing({ sellerApproved: false, brokerDraft: null }), false);
  assert.equal(approvedForSharing({ sellerApproved: null, brokerDraft: "  " }), false);
  assert.equal(approvedForSharing({ sellerApproved: true, brokerDraft: null }), true);
  assert.equal(approvedForSharing({ sellerApproved: false, brokerDraft: "We run 6 chairs." }), true);
  assert.equal(MAX_BUYER_QUESTION_CHARS, 1000);
});

// ── S3 ────────────────────────────────────────────────────────────────
await test("S3: the criteria read is skipped when the buyer's words are unchanged", () => {
  const stored = { buyerCriteria: { lookingFor: "Dental practices in Ontario" }, background: "Ran a dental lab." };
  assert.equal(extractionInputOf(stored as any), extractionInputFromProfile({ lookingFor: "Dental practices in Ontario ", background: "Ran a dental lab." } as any));
  assert.notEqual(extractionInputOf(stored as any), extractionInputFromProfile({ lookingFor: "HVAC in BC", background: "Ran a dental lab." } as any));
  assert.notEqual(extractionInputOf({ buyerCriteria: {}, background: null } as any), extractionInputFromProfile({ lookingFor: "x", background: "y" } as any));
});

// ── S4 ────────────────────────────────────────────────────────────────
await test("S4: every table with a deal id is covered by the deal delete", () => {
  const covered = new Set(Object.values(DEAL_CHILD_TABLES).map((e) => getTableConfig(e.table as any).name));
  const missing: string[] = [];
  for (const v of Object.values(schema)) {
    if (!(v instanceof PgTable)) continue;
    const cfg = getTableConfig(v);
    if (cfg.name === "deals") continue;
    if (cfg.columns.some((c) => c.name === "deal_id" || c.name === "invited_by_deal") && !covered.has(cfg.name)) missing.push(cfg.name);
  }
  assert.deepEqual(missing, [], `tables with a deal id not deleted with the deal: ${missing.join(", ")}`);
});
await test("S4: deleting a deal deletes every child row, detaches the rest, then the deal — in one transaction", async () => {
  const ops: string[] = [];
  let inTx = false;
  const tx = {
    delete: (t: any) => ({ where: async (w: any) => { assert.ok(inTx); ops.push(`delete ${getTableConfig(t).name} ${dialect.sqlToQuery(w).params.join(",")}`); } }),
    update: (t: any) => ({ set: (v: any) => ({ where: async (w: any) => { assert.ok(inTx); ops.push(`detach ${getTableConfig(t).name} ${Object.keys(v).join(",")}=${Object.values(v).join(",")} ${dialect.sqlToQuery(w).params.join(",")}`); } }) }),
  };
  const fakeDb: any = { transaction: async (fn: any) => { inTx = true; try { return await fn(tx); } finally { inTx = false; } } };
  await deleteDealRows(fakeDb, "D9");
  assert.equal(ops.at(-1), "delete deals D9", "the deal row goes last");
  for (const t of ["documents", "interview_sessions", "seller_invites", "buyer_access", "cim_sections", "cim_section_overrides", "buyer_questions", "financial_analyses", "discrepancies", "tasks", "deal_media", "deal_document_requirements", "deal_members", "notifications"]) {
    assert.ok(ops.includes(`delete ${t} D9`), `${t} not deleted`);
  }
  assert.ok(ops.includes("detach buyer_emails dealId= D9"));
  assert.ok(ops.includes("detach buyer_users invitedByDeal= D9"));
  // The data room (vdr spec §8): all ten tables go with the deal, by name.
  for (const t of ["vdr_rooms", "vdr_folders", "vdr_items", "vdr_shares", "vdr_buyer_settings", "vdr_requests", "vdr_views", "vdr_activity", "vdr_page_text", "vdr_team_members"]) {
    assert.ok(ops.includes(`delete ${t} D9`), `${t} not deleted with the deal`);
  }
  // Add-backs in the books (gl spec §5): all five tables go with the deal, by name.
  for (const t of ["gl_ledgers", "gl_transactions", "gl_tracing", "gl_addback_traces", "gl_trace_links"]) {
    assert.ok(ops.includes(`delete ${t} D9`), `${t} not deleted with the deal`);
  }
});
await test("S4: a deal's files are removed except those another deal's row shares", async () => {
  const rows = [
    { dealId: "D9", fileUrl: "/uploads/docs/doc_a.pdf" },
    { dealId: "D9", fileUrl: "/uploads/docs/doc_shared.pdf" },
    { dealId: "D9", fileUrl: "/uploads/../etc/passwd" },
    { dealId: "D8", fileUrl: "/uploads/docs/doc_shared.pdf" },
  ];
  let call = 0;
  const fakeDb: any = {
    select: () => ({ from: () => ({ where: async () => (call++ === 0 ? rows.filter((r) => r.dealId === "D9") : rows.filter((r) => r.dealId !== "D9")) }) }),
  };
  const files = await dealFilesToRemove(fakeDb, "D9", "/data/uploads");
  assert.deepEqual(files, ["/data/uploads/docs/doc_a.pdf"]);
});

// ── S5 ────────────────────────────────────────────────────────────────
await test("S5: per-address email ceiling", () => {
  const l = createPerKeyLimiter({ limit: 3, windowMs: 1000 });
  assert.deepEqual([l.take("a", 0), l.take("a", 1), l.take("a", 2), l.take("a", 3)], [true, true, true, false]);
  assert.equal(l.take("b", 3), true, "another address is separate");
  assert.equal(l.take("a", 1001), true, "the window slides");
});
await test("S5: an unverified self-signup's typed name is never greeted", () => {
  assert.equal(greetingNameFor({ name: "Call 1-888", emailVerified: false, source: "self_signup" } as any), "");
  assert.equal(greetingNameFor({ name: "Sam", emailVerified: true, source: "self_signup" } as any), "Sam");
  assert.equal(greetingNameFor({ name: "Sam", emailVerified: false, source: "broker_invited" } as any), "Sam");
});

// ── S6 ────────────────────────────────────────────────────────────────
await test("S6: mapWithConcurrency keeps order and never exceeds the limit", async () => {
  let now = 0, peak = 0;
  const out = await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (n) => {
    now++; peak = Math.max(peak, now);
    await new Promise((r) => setTimeout(r, 5 + (n % 3)));
    now--;
    return n * 2;
  });
  assert.deepEqual(out, Array.from({ length: 20 }, (_, i) => i * 2));
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
  assert.equal(BULK_OUTREACH_MAX, 50);
});
await test("S6: bulk routes carry the AI / email limits (skipAI matching stays free)", async () => {
  const app = express();
  let aiHits = 0;
  applyBulkRateLimits(app as any, (_req, _res, next) => { aiHits++; next(); });
  app.post("*", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  const post = (p: string) => new Promise<number>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "POST" }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    r.on("error", reject);
    r.end();
  });
  await post("/api/deals/D1/draft-outreach");
  await post("/api/deals/D1/match-buyers");
  await post("/api/deals/D1/match-buyers?skipAI=true");
  assert.equal(aiHits, 2);
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) statuses.push(await post("/api/deals/D1/send-outreach"));
  assert.equal(statuses.slice(0, 30).every((s) => s === 200), true);
  assert.equal(statuses[30], 429, "the 31st send in 10 minutes");
  server.close();
});

// ── S8 ────────────────────────────────────────────────────────────────
await test("S8: signing out elsewhere clears only the broker identity, keeps this session", () => {
  const q = dialect.sqlToQuery(otherBrokerSessionsSignOut("b1", "sid-7"));
  assert.match(q.sql, /UPDATE user_sessions SET sess = \(\(sess::jsonb\) - 'brokerId'\)::json WHERE \(sess::jsonb\) ->> 'brokerId' = \$1 AND sid <> \$2/);
  assert.deepEqual(q.params, ["b1", "sid-7"]);
});
await test("S8: a failed sign-out is logged, never thrown", async () => {
  const ok = await signOutOtherBrokerSessions({ execute: async () => { throw new Error("no table"); } }, "b1", "s");
  assert.equal(ok, false);
});
await test("S8: regenerating keeps a buyer signed in from the same browser", async () => {
  const req: any = { session: { brokerId: "old", buyerId: "bu1" } };
  req.session.regenerate = (cb: any) => { req.session = { fresh: true }; cb(); };
  await regenerateSession(req);
  assert.equal(req.session.fresh, true);
  assert.equal(req.session.brokerId, undefined, "the old broker identity is gone");
  assert.equal(req.session.buyerId, "bu1");
});

console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
process.exit(failed.length ? 1 : 0);
