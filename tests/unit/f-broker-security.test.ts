/**
 * Broker-app security review (F-B1, F-B5, F-B6, F-B7, F-B9, F-B11) — the pure
 * pieces. Route-level behaviour is in tests/security/f-broker-routes.test.ts.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-broker-security.test.ts
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
import { escapeHtml, sanitizeEmailFragment } from "../../server/notifications/email-escape";
import { buildEmailHtml, ownerGetsEvent, ownerMutedFor } from "../../server/notifications/service";
import { shouldAnnounceInterviewComplete } from "../../server/notifications/interview-complete";
import { inviteMintedForMember, inviteIsRevoked } from "../../shared/seller-invite-revocation";
import { teamInviteCopy } from "../../server/notifications/team-invite-copy";
import { createWebhookTokenResolver, WEBHOOK_TOKEN_SHAPE } from "../../server/calls/webhook-lookup";
import { dealPublishedForBuyers, notPublishedBody } from "../../shared/buyer-publish-gate";
import { isAiInterviewRequest, isAiQuestionRequest } from "../../server/rate-limit-scope";

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

// ── F-B9: email escaping ─────────────────────────────────────────────────
{
  const phish = `<a href="https://evil.example/login">Your Cimple session expired, sign in</a>`;
  const body = sanitizeEmailFragment(`A buyer asked: "${phish}"`);
  assert.ok(!/<a\b/i.test(body), "no live anchor survives");
  assert.ok(body.includes("&lt;a href="), "shown as text");
  // Our own formatting is kept.
  assert.equal(sanitizeEmailFragment("The seller approved <strong>Jane</strong>.<br/><br/><em>Reason:</em> fit"),
    "The seller approved <strong>Jane</strong>.<br/><br/><em>Reason:</em> fit");
  // Attributes on an allowed tag are not allowed (onclick, style…).
  assert.ok(!sanitizeEmailFragment(`<strong onclick="x()">hi</strong>`).includes("<strong onclick"));
  assert.ok(!sanitizeEmailFragment(`<img src=x onerror=alert(1)>`).includes("<img"));
  assert.ok(!sanitizeEmailFragment(`<scr<script>ipt>`).includes("<script>"));
  // Unterminated tag can't open markup.
  assert.ok(!sanitizeEmailFragment(`<a href="x"`).includes("<a"));
  assert.equal(escapeHtml(`Tom & "Jerry" <b>`), "Tom &amp; &quot;Jerry&quot; &lt;b&gt;");

  // The whole template: the escalated-question notification (routes.ts) as built.
  const html = buildEmailHtml({
    title: `New buyer question — <img src=x onerror=alert(1)>`,
    body: `A buyer asked: "${phish.slice(0, 100)}"`,
    actionUrl: "/deal/d1/qa",
    businessName: `<script>x</script>Acme`,
  });
  assert.ok(!/<a\s[^>]*evil\.example/i.test(html), "the buyer's link is not live in the email");
  assert.ok(!html.includes("<img src=x"), "title escaped");
  assert.ok(!html.includes("<script>"), "business name escaped");
  assert.ok(html.includes(`href="https://cimple-production.up.railway.app/deal/d1/qa"`) || html.includes("/deal/d1/qa\""), "our own action link stays");
}

// ── F-B3: the deal's own broker gets broker-routed events ────────────────
{
  const none: Array<{ teamType: string; email: string | null }> = [];
  for (const ev of ["buyer_decision_interested", "buyer_question", "buyer_approval_requested", "buyer_approval_seller_approved", "interview_complete", "nda_signed"]) {
    assert.equal(ownerGetsEvent(ev, "owner@broker.invalid", none), true, ev);
  }
  // Seller-only / buyer-only events never go to the broker.
  assert.equal(ownerGetsEvent("qa_needs_approval", "owner@broker.invalid", none), false);
  assert.equal(ownerGetsEvent("qa_published", "owner@broker.invalid", none), false);
  assert.equal(ownerGetsEvent("unknown_event", "owner@broker.invalid", none), false);
  assert.equal(ownerGetsEvent("buyer_question", null, none), false, "no email → nobody");
  // The broker put themselves on the team: that row (role, toggles) governs — no duplicate.
  assert.equal(ownerGetsEvent("buyer_question", "Owner@Broker.invalid", [{ teamType: "broker", email: "owner@broker.invalid" }]), false);
  // A colleague on the team doesn't take the owner's emails away.
  assert.equal(ownerGetsEvent("buyer_question", "owner@broker.invalid", [{ teamType: "broker", email: "assoc@broker.invalid" }]), true);
  // Settings → Notifications switches apply.
  assert.equal(ownerMutedFor({ notifications: { buyerDecisions: false } }, "buyer_decision_interested"), true);
  assert.equal(ownerMutedFor({ notifications: { buyerDecisions: true } }, "buyer_decision_interested"), false);
  assert.equal(ownerMutedFor({}, "buyer_question"), false);
  assert.equal(ownerMutedFor({ notifications: { interviewUpdates: false } }, "interview_complete"), true);
  // Interview-complete is announced once per finish, never for a broker-led session.
  assert.equal(shouldAnnounceInterviewComplete({ wasCompleted: false, conductedBy: "seller" }), true);
  assert.equal(shouldAnnounceInterviewComplete({ wasCompleted: true, conductedBy: "seller" }), false);
  assert.equal(shouldAnnounceInterviewComplete({ wasCompleted: false, conductedBy: "broker_with_seller" }), false);
  // …and something actually emits it.
  const sm = fs.readFileSync(path.join(REPO, "server/interview/session-manager.ts"), "utf8");
  assert.equal((sm.match(/notifyInterviewComplete\(dealId/g) || []).length, 2, "AI close + seller end both announce");
}

// ── F-B6: which seller invite a removed member was given ─────────────────
{
  const t = (s: number) => new Date(Date.UTC(2026, 8, 20, 12, 0, s));
  const primary = { id: "inv-seller", sellerEmail: "owner@acme.invalid", createdAt: t(0), sentAt: t(1), status: "accepted" };
  const bookkeeper = { id: "inv-bk", sellerEmail: "books@acme.invalid", createdAt: t(40), sentAt: null, status: "accepted" };
  const invites = [bookkeeper, primary];
  // The bookkeeper was added at t(40): the invite minted with them is theirs.
  assert.equal(inviteMintedForMember({ teamType: "seller", email: "Books@acme.invalid", invitedAt: t(40) }, invites)?.id, "inv-bk");
  // The seller added to the team AFTER being invited (Q&A routing "add as Owner"): their own invite is older → kept.
  assert.equal(inviteMintedForMember({ teamType: "seller", email: "owner@acme.invalid", invitedAt: t(3600) }, invites), null);
  // Minted with the member but since sent as the deal's seller invite → kept.
  assert.equal(inviteMintedForMember({ teamType: "seller", email: "owner@acme.invalid", invitedAt: t(0) }, invites), null);
  // Broker / buyer team members have no seller link.
  assert.equal(inviteMintedForMember({ teamType: "broker", email: "books@acme.invalid", invitedAt: t(40) }, invites), null);
  assert.equal(inviteMintedForMember({ teamType: "seller", email: "books@acme.invalid", invitedAt: null }, invites), null);
  assert.equal(inviteIsRevoked({ status: "revoked" }), true);
  assert.equal(inviteIsRevoked({ status: "accepted" }), false);
  // storage.getSellerInviteByToken / getSellerInvitesByDealId filter revoked invites.
  const storageSrc = fs.readFileSync(path.join(REPO, "server/storage.ts"), "utf8");
  const byToken = storageSrc.slice(storageSrc.indexOf("async getSellerInviteByToken(token"), storageSrc.indexOf("async getSellerInvitesByDealId(dealId"));
  assert.ok(byToken.includes("REVOKED_INVITE_STATUS"), "token lookup refuses revoked invites");
}

// ── F-B7: team invite emails say what the person gets ────────────────────
{
  const broker = teamInviteCopy({ teamType: "broker", roleLabel: "Associate", businessName: "Harbourline Dental", blindCodename: "Project Coastal", accessLevel: null, hasSellerLink: false });
  assert.ok(!/get started|sign in|log in/i.test(broker.body), broker.body);
  assert.match(broker.body, /email updates/);
  const buyer = teamInviteCopy({ teamType: "buyer", roleLabel: "Advisor", businessName: "Harbourline Dental", blindCodename: "Project Coastal", accessLevel: "full", hasSellerLink: false });
  assert.ok(!buyer.body.includes("Harbourline") && !buyer.displayName.includes("Harbourline"), "blind buyer-team email never names the business");
  assert.match(buyer.body, /Project Coastal/);
  const buyerNoCode = teamInviteCopy({ teamType: "buyer", roleLabel: "Advisor", businessName: "Harbourline Dental", blindCodename: null, accessLevel: "teaser", hasSellerLink: false });
  assert.ok(!buyerNoCode.body.includes("Harbourline"));
  const buyerLoi = teamInviteCopy({ teamType: "buyer", roleLabel: "Attorney", businessName: "Harbourline Dental", blindCodename: "Project Coastal", accessLevel: "loi", hasSellerLink: false });
  assert.match(buyerLoi.body, /Harbourline Dental/, "named CIM levels may name it");
  const seller = teamInviteCopy({ teamType: "seller", roleLabel: "Accountant", businessName: "Harbourline Dental", blindCodename: null, accessLevel: null, hasSellerLink: true });
  assert.match(seller.body, /seller workspace/);
}

// ── F-B11: webhook tokens resolve without a table scan ───────────────────
{
  let lookups = 0;
  const known = new Map<string, string>();
  const good = "A".repeat(20) + "b_-9".repeat(3); // 32 chars, base64url
  assert.ok(WEBHOOK_TOKEN_SHAPE.test(good));
  let now = 1_000_000;
  const resolve = createWebhookTokenResolver(known, async (tok) => { lookups++; return tok === good ? "deal-1" : null; }, () => now);
  (async () => {
    assert.equal(await resolve("x"), null);
    assert.equal(await resolve(""), null);
    assert.equal(await resolve("' or 1=1 --" + "a".repeat(21)), null);
    assert.equal(lookups, 0, "malformed tokens never query");
    const junk = "Z".repeat(32);
    for (let i = 0; i < 50; i++) assert.equal(await resolve(junk), null);
    assert.equal(lookups, 1, "a repeated miss is cached");
    now += 61_000;
    await resolve(junk);
    assert.equal(lookups, 2, "the miss cache expires");
    assert.equal(await resolve(good), "deal-1");
    assert.equal(await resolve(good), "deal-1");
    assert.equal(lookups, 3, "a hit is remembered in the token map");
    assert.equal(known.get(good), "deal-1");
    // The route no longer scans every deal.
    const routes = fs.readFileSync(path.join(REPO, "server/routes.ts"), "utf8");
    const hook = routes.slice(routes.indexOf('app.post("/api/calls/recall/webhook/"'), routes.indexOf('app.get("/api/calls/status"'));
    assert.ok(!hook.includes("getAllDeals"), "webhook route does not load all deals");
    console.log("f-broker-security: webhook ok");
  })().catch((e) => { console.error(e); process.exit(1); });
}

// ── F-B2: publishing gates buyers ────────────────────────────────────────
{
  assert.equal(dealPublishedForBuyers({ isLive: false }), false);
  assert.equal(dealPublishedForBuyers({ isLive: null }), false);
  assert.equal(dealPublishedForBuyers(undefined), false);
  assert.equal(dealPublishedForBuyers({ isLive: true }), true);
  const body = notPublishedBody();
  assert.equal(body.code, "not_published");
  assert.ok(!/phase|draft|discrepanc/i.test(body.error), "the buyer message is neutral");
}

// ── F-B4: only model-running requests count against the AI limit ─────────
{
  assert.equal(isAiInterviewRequest("POST", "/api/interview/d1/message/stream"), true);
  assert.equal(isAiInterviewRequest("POST", "/api/interview/d1/message"), true);
  assert.equal(isAiInterviewRequest("POST", "/api/interview/d1/start"), true);
  assert.equal(isAiInterviewRequest("POST", "/api/interview/d1/end"), true);
  assert.equal(isAiInterviewRequest("GET", "/api/interview/d1/call/bot/lines"), false);
  assert.equal(isAiInterviewRequest("POST", "/api/interview/d1/call/bot/start"), false);
  assert.equal(isAiInterviewRequest("POST", "/api/interview/d1/transcription-token"), false);
  assert.equal(isAiInterviewRequest("GET", "/api/interview/session/s1/history"), false);
  assert.equal(isAiQuestionRequest("POST"), true);
  assert.equal(isAiQuestionRequest("GET"), false);
}

console.log("f-broker-security: ok");
