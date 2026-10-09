/**
 * "Ask the seller to check it" (server/teaser/seller-check.ts), through the
 * real routes:
 *  - no seller-team owner → 409 no_seller_owner (nothing sent);
 *  - send → a snapshot of the guarded, visible draft + the existing cim_ready
 *    seller email marked kind "teaser";
 *  - only the owner's link approves or asks for changes (others read, 403);
 *  - changes → a broker task; "approved an earlier version" after a draft edit;
 *  - the CIM's seller-review status ignores teaser sends.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-seller-check.test.ts
 */
import { T, seedPacific, startHarness, pacificWritten } from "../utils/teaser-harness";
import assert from "node:assert/strict";

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
  let rev = (await waitForTeaser("D-PAC"))!.draftRev;

  await check("no seller-team owner → 409 'Add the seller on the Team tab first', nothing sent", async () => {
    const r = await call("POST", "/api/deals/D-PAC/teaser/seller-check", { rev }, broker);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "no_seller_owner");
    assert.match(r.json.error, /Team tab/);
    assert.equal(T.notifications.length, 0);
  });

  T.invites.push(
    { id: "I-own", dealId: "D-PAC", token: "seller-own", sellerEmail: "harjit@seller.invalid", sellerName: "Harjit Sandhu", status: "accepted" },
    { id: "I-acc", dealId: "D-PAC", token: "seller-acc", sellerEmail: "cpa@seller.invalid", sellerName: "Rita Chen CPA", status: "accepted" },
  );
  T.members.push({ id: "M-acc", dealId: "D-PAC", teamType: "seller", role: "accountant", email: "cpa@seller.invalid", name: "Rita Chen", inviteStatus: "accepted" });

  await check("send: a snapshot of the guarded visible draft + cim_ready marked kind 'teaser'", async () => {
    const r = await call("POST", "/api/deals/D-PAC/teaser/seller-check", { rev }, broker);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.teaser.sellerCheck.status, "sent");
    assert.equal(r.json.summary.seller.state, "sent");
    const n = T.notifications.filter((x) => x.type === "cim_ready");
    assert.ok(n.length >= 1);
    assert.ok(n.every((x) => x.metadata.kind === "teaser"));
    assert.equal(n[0].title, "Your broker would like you to check the teaser");
    assert.ok(n.every((x) => x.actionUrl === "/seller/…/review"), "the log keeps the page, never the token");
  });

  await check("the seller reads it; only the owner's link signs off", async () => {
    const g = await call("GET", "/api/seller/seller-acc/teaser-review");
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.available, true);
    assert.equal(g.json.canApprove, false);
    assert.match(g.json.readOnlyMessage, /Only Harjit Sandhu can approve the teaser/);
    assert.ok(g.json.blocks.length >= 4);
    assert.ok(!/Pacific Coast|Surrey/.test(g.text));
    const no = await call("POST", "/api/seller/seller-acc/teaser-review/approve", {});
    assert.equal(no.status, 403);
    assert.equal(no.json.code, "not_owner");
    const own = await call("GET", "/api/seller/seller-own/teaser-review");
    assert.equal(own.json.canApprove, true);
    const ok = await call("POST", "/api/seller/seller-own/teaser-review/approve", {});
    assert.equal(ok.status, 200, ok.text);
    const s = await call("GET", "/api/deals/D-PAC/teaser/summary", undefined, broker);
    assert.equal(s.json.seller.state, "approved");
    assert.ok(T.notifications.some((x) => x.type === "cim_seller_approved" && x.metadata.kind === "teaser"));
  });

  await check("a draft edit after the approval → 'approved an earlier version'", async () => {
    const st = await call("GET", "/api/deals/D-PAC/teaser", undefined, broker);
    rev = st.json.teaser.draftRev;
    const over = st.json.teaser.draft.blocks.find((b: { slot: string }) => b.slot === "overview");
    const e = await call("PATCH", `/api/deals/D-PAC/teaser/blocks/${over.id}`, { rev, body: "A regional carrier with a strong team." }, broker);
    assert.equal(e.status, 200, e.text);
    assert.equal(e.json.summary.seller.state, "approved_earlier");
    rev = e.json.teaser.draftRev;
  });

  await check("changes requested → a broker task; the CIM's review status ignores teaser sends", async () => {
    await call("POST", "/api/deals/D-PAC/teaser/seller-check", { rev }, broker);
    const short = await call("POST", "/api/seller/seller-own/teaser-review/request-changes", { note: "x" });
    assert.equal(short.status, 400);
    const r = await call("POST", "/api/seller/seller-own/teaser-review/request-changes", { note: "Please don't mention the refrigerated lanes — only two carriers do that here." });
    assert.equal(r.status, 200, r.text);
    const task = T.tasks.find((t) => t.id === r.json.taskId);
    assert.equal(task.createdBy, "seller_teaser_review");
    assert.equal(task.title, "Harjit Sandhu asked for changes to the teaser");
    const s = await call("GET", "/api/deals/D-PAC/teaser/summary", undefined, broker);
    assert.equal(s.json.seller.state, "changes_requested");
    assert.match(s.json.seller.note, /refrigerated lanes/);
    const cim = await call("GET", "/api/deals/D-PAC/seller-review", undefined, broker);
    assert.equal(cim.status, 200, cim.text);
    assert.equal(cim.json.lastSentAt, null, "teaser sends are not the CIM's review");
    assert.deepEqual(cim.json.changeRequests, [], "teaser change requests are not the CIM's");
  });

  await check("the deal's broker previewing the seller's link can't sign off for them", async () => {
    const r = await call("POST", "/api/seller/seller-own/teaser-review/approve", {}, broker);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "broker_preview");
  });

  await h.close();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
