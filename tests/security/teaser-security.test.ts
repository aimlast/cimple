/**
 * Teaser security:
 *  - tenancy: another broker's deal → 404 on every teaser route; another
 *    broker's saved template → 404;
 *  - strict bodies: unknown keys → 400 (server-owned fields can't be set);
 *  - logs redact every new /api/view/<token>/… and /api/seller/<token>/teaser-review path;
 *  - the AI limiter applies only to model-running teaser requests
 *    (aiLimiterWhen: mode "ai", convert "ai"), never to blank edits.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/security/teaser-security.test.ts
 */
import { T, seedPacific, startHarness, pacificWritten, mkAccess } from "../utils/teaser-harness";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const h = await startHarness();
  const { call, broker } = h;
  seedPacific();
  h.modelReplies.push(pacificWritten());
  await call("POST", "/api/deals/D-PAC/teaser/generate", { templateKey: "one_page" }, broker);
  const { waitForTeaser } = await import("../../server/teaser/generate");
  const row = (await waitForTeaser("D-PAC"))!;
  const blockId = row.draft.blocks[1].id;
  const other = { "x-test-broker": "B2" };

  await check("another broker's deal: 404 on every teaser route (and 401 signed out)", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/api/deals/D-PAC/teaser"],
      ["GET", "/api/deals/D-PAC/teaser/summary"],
      ["POST", "/api/deals/D-PAC/teaser/generate", { templateKey: "one_page", replace: true }],
      ["POST", "/api/deals/D-PAC/teaser/from-template", { templateKey: "one_page", replace: true }],
      ["PATCH", "/api/deals/D-PAC/teaser/settings", { rev: row.draftRev, numbers: "rounded" }],
      ["PATCH", "/api/deals/D-PAC/teaser/header", { rev: row.draftRev, tagline: "x" }],
      ["POST", "/api/deals/D-PAC/teaser/blocks", { rev: row.draftRev, layoutType: "prose_highlight", title: "x", mode: "blank" }],
      ["PATCH", `/api/deals/D-PAC/teaser/blocks/${blockId}`, { rev: row.draftRev, title: "x" }],
      ["PATCH", `/api/deals/D-PAC/teaser/blocks/${blockId}/cells/revenue`, { rev: row.draftRev, value: "x" }],
      ["DELETE", `/api/deals/D-PAC/teaser/blocks/${blockId}?rev=${row.draftRev}`],
      ["POST", `/api/deals/D-PAC/teaser/blocks/${blockId}/duplicate`, { rev: row.draftRev }],
      ["POST", "/api/deals/D-PAC/teaser/reorder", { rev: row.draftRev, ids: [] }],
      ["PATCH", `/api/deals/D-PAC/teaser/blocks/${blockId}/layout`, { rev: row.draftRev, layoutType: "callout_list", convert: "blank" }],
      ["POST", `/api/deals/D-PAC/teaser/blocks/${blockId}/rewrite`, { instructions: "x" }],
      ["POST", `/api/deals/D-PAC/teaser/blocks/${blockId}/reset`, { rev: row.draftRev }],
      ["POST", "/api/deals/D-PAC/teaser/undo", { rev: row.draftRev }],
      ["POST", "/api/deals/D-PAC/teaser/confirm-review", { rev: row.draftRev }],
      ["POST", "/api/deals/D-PAC/teaser/publish", { rev: row.draftRev }],
      ["POST", "/api/deals/D-PAC/teaser/unpublish", {}],
      ["DELETE", "/api/deals/D-PAC/teaser"],
      ["POST", "/api/deals/D-PAC/teaser/seller-check", { rev: row.draftRev }],
      ["GET", "/api/deals/D-PAC/teaser/preview?draft=1"],
      ["GET", "/api/deals/D-PAC/teaser/engagement"],
      ["POST", "/api/deals/D-PAC/teaser/save-template", { name: "Mine" }],
    ];
    for (const [m, p, b] of routes) {
      const r = await call(m, p, b, other);
      assert.equal(r.status, 404, `${m} ${p} → ${r.status}`);
      const anon = await call(m, p, b);
      assert.equal(anon.status, 401, `${m} ${p} signed out → ${anon.status}`);
    }
    assert.ok(await h.teasers.get("D-PAC"), "the teaser is untouched");
    assert.equal((await h.teasers.get("D-PAC"))!.draftRev, row.draftRev);
  });

  await check("another broker's saved template: 404 to rename or delete", async () => {
    const s = await call("POST", "/api/deals/D-PAC/teaser/save-template", { name: "Brassline house style" }, broker);
    assert.equal(s.status, 200, s.text);
    const tid = s.json.template.id;
    assert.equal((await call("PATCH", `/api/broker/teaser-templates/${tid}`, { name: "Stolen" }, other)).status, 404);
    assert.equal((await call("DELETE", `/api/broker/teaser-templates/${tid}`, undefined, other)).status, 404);
    const mine = await call("GET", "/api/broker/teaser-templates", undefined, other);
    assert.deepEqual(mine.json.templates, []);
  });

  await check("strict bodies: unknown or server-owned keys → 400", async () => {
    const bad: Array<[string, string, unknown]> = [
      ["PATCH", "/api/deals/D-PAC/teaser/settings", { rev: row.draftRev, published: { header: null, blocks: [] } }],
      ["PATCH", `/api/deals/D-PAC/teaser/blocks/${blockId}`, { rev: row.draftRev, origin: "fixed" }],
      ["PATCH", "/api/deals/D-PAC/teaser/header", { rev: row.draftRev, codenameUsed: "Project X" }],
      ["POST", "/api/deals/D-PAC/teaser/generate", { templateKey: "one_page", basis: "redacted_facts" }],
      ["POST", "/api/deals/D-PAC/teaser/publish", {}],
      ["PATCH", "/api/broker/teaser-settings", { defaultTemplate: "one_page", brokerId: "B2" }],
    ];
    for (const [m, p, b] of bad) assert.equal((await call(m, p, b, broker)).status, 400, `${m} ${p}`);
    const link = mkAccess();
    assert.equal((await call("POST", `/api/view/${link.accessToken}/teaser-pass`, { reasons: ["size"], buyerEmail: "x@y.invalid" })).status, 403, "unpublished teaser: refused before the body matters");
  });

  await check("logs redact every new buyer and seller token path", async () => {
    const { formatRequestLogLine } = await import("../../server/log-redact");
    const tok = "0f3c2a1e-9b8d-4c7e-a6f5-1234567890ab";
    for (const p of [`/api/view/${tok}/email-check`, `/api/view/${tok}/email-check/verify`, `/api/view/${tok}/cim-request`, `/api/view/${tok}/cim-request/note`, `/api/view/${tok}/teaser-pass`, `/api/view/${tok}/fresh-link`, `/api/seller/${tok}/teaser-review`, `/api/seller/${tok}/teaser-review/approve`]) {
      const line = formatRequestLogLine("POST", p, 200, 5, { secret: "code 482913" });
      assert.ok(!line.includes(tok), `token leaked: ${line}`);
      assert.ok(!line.includes("482913"), `body leaked: ${line}`);
    }
  });

  await check("the AI limiter applies only to model-running teaser requests", async () => {
    const { applyTeaserRateLimits } = await import("../../server/routes/teaser");
    const app = express();
    app.use(express.json());
    const hits: string[] = [];
    applyTeaserRateLimits(app, (req, res) => { hits.push(`${req.method} ${req.originalUrl}`); res.status(429).json({ limited: true }); });
    app.use((_req, res) => { res.status(200).json({ ok: true }); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const req = (m: string, p: string, b?: unknown) => globalThis.fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.status);
    assert.equal(await req("POST", "/api/deals/D1/teaser/generate", { templateKey: "one_page" }), 429);
    assert.equal(await req("POST", "/api/deals/D1/teaser/blocks/b1/rewrite", {}), 429);
    assert.equal(await req("POST", "/api/deals/D1/teaser/blocks", { mode: "ai" }), 429);
    assert.equal(await req("POST", "/api/deals/D1/teaser/blocks", { mode: "blank" }), 200, "a blank block is never limited");
    assert.equal(await req("PATCH", "/api/deals/D1/teaser/blocks/b1", { title: "x", mode: "ai" }), 200, "a block edit is never limited");
    assert.equal(await req("PATCH", "/api/deals/D1/teaser/blocks/b1/layout", { convert: "ai" }), 429);
    assert.equal(await req("PATCH", "/api/deals/D1/teaser/blocks/b1/layout", { convert: "blank" }), 200);
    assert.equal(await req("PATCH", "/api/deals/D1/teaser/settings", { numbers: "rounded" }), 200);
    server.close();
  });

  void T;
  await h.close();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
